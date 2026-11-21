// #588: the invoice page's Print opens the stored copy in a tab it opened at the click, and shows
// the folder line (the plan's T5; Amendment 8's tab ruling and Amendments 8 and 9's print lines).
// A finalized print's answer waits for its copy in the customer's folder, up to 10 seconds, and a
// browser blocks a tab a page opens long after the click, so the page opens a blank tab in the
// click and fills it with `/api/documents/<x-document-id>` when the print lands. A refused print
// closes the blank tab; a finalized print the route did not file is one amber line by Print.
//
// The first half runs `src/lib/print-tab.ts` over a fake window. The second lifts the page's own
// `printInvoice` out of InvoiceDetail.tsx's syntax tree and runs it closed over the real leaf, a
// fake window, a fake `trackedFetch` and recorded setters, nothing else of the page's module in
// reach: a free identifier the function gains on a path these cases take must be added here in the
// same change, or it is a ReferenceError in this file. One event log, shared by the window, the tab,
// the fetch and the setters, holds the order things happen in.
//
// #692 adds the order hub's traveler `print` and the saved shipment's `printDoc`, each lifted from
// the `useCallback` it is declared in (`hookCallback`) and run the same way.
import { describe, expect, it, vi } from "vitest";
import {
  PRINT_NOT_CONNECTED, PRINT_SKIPPED, PRINT_WARNING_UNREADABLE,
} from "@/lib/customer-folder-words";
import { openPendingTab, printWarningSentence } from "@/lib/print-tab";
import { callback, runNode, source } from "./helpers/lift-callback";
import { ApiError } from "@/lib/fetcher";
import ts from "typescript";

/** The page's sentence for a print no tab shows, typed out: a changed word fails this suite. */
const BLOCKED = "The browser blocked the print window — the document was archived and is in Documents & history.";
/** The page's own address: an install reached by LAN address over plain HTTP, as `.182` is. */
const PAGE_URL = "http://192.0.2.10/invoicing/invoice-1";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** One macrotask: every promise reaction queued so far has run. */
const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });

/** A window whose `open` answers a recording tab, or null when the browser blocks it. Every call
 *  that reaches the window or the tab is written to `events`. */
function fakeWindow(events: string[], blocked = false) {
  const tab = {
    opener: "the invoice page" as unknown,
    closed: false,
    close: vi.fn(() => { events.push("close"); tab.closed = true; }),
    location: { replace: vi.fn((url: string) => { events.push(`replace ${url}`); }) },
  };
  const open = vi.fn((url: string, target: string) => {
    events.push(`open ${JSON.stringify(url)} ${target}`);
    return blocked ? null : tab;
  });
  const win = { open, location: { href: PAGE_URL } } as unknown as Pick<Window, "open" | "location">;
  return { win, open, tab };
}

/** `x-print-warnings` as the route writes it: a URI-encoded JSON array. */
const header = (value: unknown) => encodeURIComponent(JSON.stringify(value));

describe("openPendingTab", () => {
  it("opens one blank tab itself, cuts its opener and shows nothing yet", () => {
    const events: string[] = [];
    const w = fakeWindow(events);
    expect(w.open).not.toHaveBeenCalled();
    const tab = openPendingTab(w.win);
    expect(w.open.mock.calls).toEqual([["", "_blank"]]);
    expect(w.tab.opener).toBeNull();
    expect(tab.blocked).toBe(false);
    expect(events).toEqual(['open "" _blank']);
  });

  it("shows a path by replacing the tab's address with it, made absolute against the page's own", () => {
    const events: string[] = [];
    const w = fakeWindow(events);
    openPendingTab(w.win).show("/api/documents/doc-9");
    expect(w.tab.location.replace.mock.calls).toEqual([["http://192.0.2.10/api/documents/doc-9"]]);
    expect(w.tab.close).not.toHaveBeenCalled();
  });

  it("closes the blank tab", () => {
    const events: string[] = [];
    const w = fakeWindow(events);
    openPendingTab(w.win).close();
    expect(w.tab.close).toHaveBeenCalledTimes(1);
    expect(w.tab.location.replace).not.toHaveBeenCalled();
  });

  it("a blocked tab says so, and showing or closing it does nothing and does not throw", () => {
    const events: string[] = [];
    const w = fakeWindow(events, true);
    const tab = openPendingTab(w.win);
    expect(tab.blocked).toBe(true);
    expect(() => tab.show("/api/documents/doc-9")).not.toThrow();
    expect(() => tab.close()).not.toThrow();
    expect(events).toEqual(['open "" _blank']);
  });

  it("a tab the user closed while the print was out is neither navigated nor closed again", () => {
    const events: string[] = [];
    const w = fakeWindow(events);
    const tab = openPendingTab(w.win);
    w.tab.closed = true;
    expect(() => tab.show("/api/documents/doc-9")).not.toThrow();
    expect(() => tab.close()).not.toThrow();
    expect(w.tab.location.replace).not.toHaveBeenCalled();
    expect(w.tab.close).not.toHaveBeenCalled();
  });

  it("a second close is no call to the browser", () => {
    const events: string[] = [];
    const w = fakeWindow(events);
    const tab = openPendingTab(w.win);
    tab.close();
    tab.close();
    expect(w.tab.close).toHaveBeenCalledTimes(1);
  });

  it("a navigation or a close the browser refuses is swallowed", () => {
    const events: string[] = [];
    const w = fakeWindow(events);
    w.tab.location.replace.mockImplementation(() => { throw new DOMException("refused", "SecurityError"); });
    w.tab.close.mockImplementation(() => { throw new DOMException("refused", "SecurityError"); });
    const tab = openPendingTab(w.win);
    expect(() => tab.show("/api/documents/doc-9")).not.toThrow();
    expect(() => tab.close()).not.toThrow();
    expect(w.tab.location.replace).toHaveBeenCalledTimes(1);
    expect(w.tab.close).toHaveBeenCalledTimes(1);
  });
});

describe("printWarningSentence", () => {
  it("no header is no line", () => {
    expect(printWarningSentence(null)).toBeNull();
  });

  it("one sentence is that sentence, its em dash decoded", () => {
    expect(printWarningSentence(header([PRINT_NOT_CONNECTED]))).toBe(PRINT_NOT_CONNECTED);
  });

  it("two sentences are one line, joined by a space", () => {
    expect(printWarningSentence(header([PRINT_NOT_CONNECTED, PRINT_SKIPPED])))
      .toBe(`${PRINT_NOT_CONNECTED} ${PRINT_SKIPPED}`);
  });

  it.each([
    ["a header that is not URI-encoded text", "%E0%A4%A"],
    ["a header that is not JSON", encodeURIComponent('["Not filed')],
    ["a string, not an array", header(PRINT_NOT_CONNECTED)],
    ["an object, not an array", header({ warning: PRINT_NOT_CONNECTED })],
    ["null", header(null)],
    ["an array holding a number", header([PRINT_NOT_CONNECTED, 3])],
  ])("%s is the unreadable-header sentence", (_label, value) => {
    expect(printWarningSentence(value)).toBe(PRINT_WARNING_UNREADABLE);
  });
});

// ---- The page's Print ----

const PAGE = "app/invoicing/[id]/InvoiceDetail.tsx";

/** A print answer: the PDF's bytes as the body, `headers` beside them. */
const printed = (headers: Record<string, string>, body: BodyInit = new Uint8Array([0x25, 0x50, 0x44, 0x46])) =>
  new Response(body, { status: 200, headers: { "content-type": "application/pdf", ...headers } });

/** The invoice page's own `printInvoice`, closed over the real leaf, a fake window and spies. The
 *  print request waits in `answer` until the case settles it. */
function invoicePrint(blocked = false) {
  const events: string[] = [];
  const w = fakeWindow(events, blocked);
  const answer = deferred<Response>();
  let docsRefresh = 0;
  const trackedFetch = vi.fn((url: string, init?: RequestInit) => {
    events.push(`fetch ${init?.method} ${url}`);
    return answer.promise;
  });
  const setters = {
    setPrinting: vi.fn((value: boolean) => { events.push(`printing ${value}`); }),
    setPrintError: vi.fn((value: string | null) => { events.push(`error ${value}`); }),
    setPrintWarning: vi.fn((value: string | null) => { events.push(`warning ${value}`); }),
    setDocsRefresh: vi.fn((update: (n: number) => number) => {
      docsRefresh = update(docsRefresh);
      events.push(`documents ${docsRefresh}`);
    }),
  };
  const printInvoice = callback<() => Promise<void>>(PAGE, "InvoiceDetail", "printInvoice", {
    id: "invoice-1", window: w.win, openPendingTab, printWarningSentence, trackedFetch, ...setters,
  });
  return { printInvoice, answer, events, trackedFetch, tab: w.tab, ...setters };
}

describe("the invoice page's Print (#588)", () => {
  it("opens the tab in the click, before it marks the page printing and before the request is sent", async () => {
    const p = invoicePrint();
    const done = p.printInvoice();
    expect(p.events).toEqual(['open "" _blank', "printing true", "error null", "warning null", "fetch POST /api/invoices/invoice-1/print"]);
    p.answer.resolve(printed({ "x-document-id": "doc-9" }));
    await done;
  });

  it("an answer with a document id shows the stored copy in the tab, then bumps Documents, with no line", async () => {
    const p = invoicePrint();
    const done = p.printInvoice();
    const res = printed({ "x-document-id": "doc-9" });
    p.answer.resolve(res);
    await done;
    expect(p.events.slice(5)).toEqual([
      "replace http://192.0.2.10/api/documents/doc-9", "warning null", "documents 1", "printing false",
    ]);
    expect(p.tab.close).not.toHaveBeenCalled();
    expect(p.setPrintError.mock.calls).toEqual([[null]]);
    expect(p.setPrintWarning.mock.calls).toEqual([[null], [null]]);
    // The tab reads the stored bytes, so the page cancels the answer's body rather than reading it.
    expect(res.bodyUsed).toBe(true);
  });

  it("a copy that did not land is the route's sentence, set before Documents is bumped", async () => {
    const p = invoicePrint();
    const done = p.printInvoice();
    p.answer.resolve(printed({ "x-document-id": "doc-9", "x-print-warnings": header([PRINT_NOT_CONNECTED]) }));
    await done;
    expect(p.events.slice(5)).toEqual([
      "replace http://192.0.2.10/api/documents/doc-9", `warning ${PRINT_NOT_CONNECTED}`, "documents 1", "printing false",
    ]);
    expect(p.setPrintError.mock.calls).toEqual([[null]]);
  });

  it("a header the page cannot read is the unreadable-header sentence", async () => {
    const p = invoicePrint();
    const done = p.printInvoice();
    p.answer.resolve(printed({ "x-document-id": "doc-9", "x-print-warnings": "%E0%A4%A" }));
    await done;
    expect(p.setPrintWarning.mock.calls).toEqual([[null], [PRINT_WARNING_UNREADABLE]]);
  });

  it("a blocked tab says the print is in Documents, once the print has landed, beside the folder line", async () => {
    const p = invoicePrint(true);
    const done = p.printInvoice();
    expect(p.setPrintError.mock.calls).toEqual([[null]]);
    p.answer.resolve(printed({ "x-document-id": "doc-9", "x-print-warnings": header([PRINT_SKIPPED]) }));
    await done;
    expect(p.events.slice(5)).toEqual([`error ${BLOCKED}`, `warning ${PRINT_SKIPPED}`, "documents 1", "printing false"]);
  });

  it("an answer with no document id closes the blank tab and says the print is in Documents", async () => {
    const p = invoicePrint();
    const done = p.printInvoice();
    p.answer.resolve(printed({}));
    await done;
    expect(p.events.slice(5)).toEqual(["close", `error ${BLOCKED}`, "warning null", "documents 1", "printing false"]);
    expect(p.tab.location.replace).not.toHaveBeenCalled();
  });

  it("a refused print closes the blank tab before it reads the refusal, and shows the refusal alone", async () => {
    const p = invoicePrint();
    const done = p.printInvoice();
    const refusal = new Response(JSON.stringify({ error: "Invoice not found" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
    const read = refusal.json.bind(refusal);
    refusal.json = () => { p.events.push("read refusal"); return read(); };
    p.answer.resolve(refusal);
    await done;
    expect(p.events.slice(5)).toEqual(["close", "read refusal", "error Invoice not found", "printing false"]);
    expect(p.tab.location.replace).not.toHaveBeenCalled();
    expect(p.setPrintWarning.mock.calls).toEqual([[null]]);
    expect(p.setDocsRefresh).not.toHaveBeenCalled();
  });

  it("a request that never answered closes the blank tab and shows its error", async () => {
    const p = invoicePrint();
    const done = p.printInvoice();
    p.answer.reject(new TypeError("Failed to fetch"));
    await done;
    expect(p.events.slice(5)).toEqual(["close", "error Failed to fetch", "printing false"]);
    expect(p.setPrintWarning.mock.calls).toEqual([[null]]);
    expect(p.setDocsRefresh).not.toHaveBeenCalled();
  });

  it.each([
    ["refused", (answer: Deferred<Response>) => answer.resolve(new Response("{}", { status: 409 })), "Print failed (409)"],
    ["never answered", (answer: Deferred<Response>) => answer.reject(new TypeError("Failed to fetch")), "Failed to fetch"],
  ] as const)("a print %s with a blocked tab shows its own message and never the blocked line", async (_label, settle, message) => {
    const p = invoicePrint(true);
    const done = p.printInvoice();
    settle(p.answer);
    await done;
    expect(p.setPrintError.mock.calls).toEqual([[null], [message]]);
    expect(p.setPrinting.mock.calls).toEqual([[true], [false]]);
  });

  // Node reports an unhandled rejection once the microtasks of the task that caused it have drained,
  // so two macrotasks are waited out before the listener comes off (the invoice-reads.test.ts shape).
  it("an answer whose body failed before it was cancelled leaves no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const p = invoicePrint();
      const done = p.printInvoice();
      const cut = new ReadableStream({ start(controller) { controller.error(new Error("connection reset")); } });
      p.answer.resolve(printed({ "x-document-id": "doc-9" }, cut));
      await done;
      await flush();
      await flush();
      expect(unhandled.mock.calls).toEqual([]);
      expect(p.events.slice(5)).toEqual([
        "replace http://192.0.2.10/api/documents/doc-9", "warning null", "documents 1", "printing false",
      ]);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

/** The arrow a component hands `useCallback` as `name`, run over `environment` (the `callback` form
 *  for a handler declared as `const name = useCallback(async (…) => …, deps)`). */
function hookCallback<T>(path: string, owner: string, name: string, environment: Record<string, unknown>): T {
  const file = source(path);
  let found: ts.Expression | undefined;
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer
        && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
        && node.initializer.expression.text === "useCallback") found = node.initializer.arguments[0];
    ts.forEachChild(node, walk);
  };
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === owner) walk(statement);
  }
  if (!found) throw new Error(`Missing production useCallback ${owner}.${name}`);
  return runNode<T>(found, file, environment);
}

/** The order hub's traveler `print`, closed over the real leaf, a fake window and spies (#692). */
function travelerPrint(opts: { blocked?: boolean; allowed?: boolean } = {}) {
  const events: string[] = [];
  const w = fakeWindow(events, opts.blocked);
  const answer = deferred<Response>();
  const trackedFetch = vi.fn((url: string, init?: RequestInit) => {
    events.push(`fetch ${init?.method} ${url}`);
    return answer.promise;
  });
  const setters = {
    setPrinting: vi.fn((value: boolean) => { events.push(`printing ${value}`); }),
    setBlocked: vi.fn((value: { id: string; label: string } | null) => { events.push(`blocked ${JSON.stringify(value)}`); }),
    setError: vi.fn((value: string | null) => { events.push(`error ${value}`); }),
  };
  const load = vi.fn(async () => { events.push("documents read"); });
  const print = hookCallback<(loadNumber?: number, intent?: unknown, openTab?: boolean) => Promise<void>>(
    "app/orders/[id]/DocumentsSection.tsx", "TravelerProvider", "print", {
      printGate: { allowed: opts.allowed ?? true }, printInFlight: { current: false },
      draftStore: { getSnapshot: () => ({ identityReady: true }), labelsForPath: () => [] },
      pathname: "/orders/order-1", unsavedPresentExcluding: () => false, NOT_PRINTED_ON_A_TRAVELER: [],
      loads: [{ loadNumber: 1 }], orderId: "order-1", window: w.win, openPendingTab, trackedFetch, ApiError,
      onPrinted: () => { events.push("printed"); }, load, URL, setTimeout, ...setters,
    });
  return { print, answer, events, tab: w.tab, open: w.open, ...setters };
}

describe("the order hub's traveler print (#692)", () => {
  it("a click opens the tab before the request is sent, and the stored copy shows in it", async () => {
    const p = travelerPrint();
    const done = p.print(1, undefined, true);
    expect(p.events).toEqual(['open "" _blank', "printing true", "blocked null", "error null", "fetch POST /api/orders/order-1/traveler?load=1"]);
    const res = printed({ "x-document-id": "doc-7" });
    p.answer.resolve(res);
    await done;
    expect(p.events.slice(5)).toEqual([
      "printed", "replace http://192.0.2.10/api/documents/doc-7", "error null", "documents read", "printing false",
    ]);
    expect(p.setBlocked.mock.calls).toEqual([[null]]); // no interim "could not be opened" line
    expect(p.tab.close).not.toHaveBeenCalled();
    expect(res.bodyUsed).toBe(true); // cancelled, never read: the tab reads the stored copy
  });

  it("a refused print closes the blank tab and shows the server's sentence", async () => {
    const p = travelerPrint();
    const done = p.print(undefined, undefined, true);
    p.answer.resolve(new Response(JSON.stringify({ error: "Order is voided" }), { status: 400 }));
    await done;
    expect(p.tab.close).toHaveBeenCalledTimes(1);
    expect(p.setError.mock.calls.at(-1)).toEqual(["Order is voided"]);
    expect(p.events).not.toContain("printed");
  });

  it("a blocked tab keeps the link to the stored copy, under the print's own label", async () => {
    const p = travelerPrint({ blocked: true });
    const done = p.print(1, undefined, true);
    p.answer.resolve(printed({ "x-document-id": "doc-7" }));
    await done;
    expect(p.setBlocked.mock.calls).toEqual([[null], [{ id: "doc-7", label: "the load 1 traveler" }]]);
  });

  it("a print the gate refuses opens no tab", async () => {
    const p = travelerPrint({ allowed: false });
    await p.print(undefined, undefined, true);
    expect(p.open).not.toHaveBeenCalled();
    expect(p.events).toEqual([]);
  });

  it("an automatic print (no click) opens no blank tab: it opens the PDF itself after the answer", async () => {
    const p = travelerPrint();
    const done = p.print();
    expect(p.events[0]).toBe("printing true");
    p.answer.resolve(printed({ "x-document-id": "doc-7" }));
    await done;
    expect(p.open.mock.calls).toHaveLength(1);
    expect(String(p.open.mock.calls[0][0])).toMatch(/^blob:/);
  });

  it("the print buttons' entry point is a click: it asks for the tab", () => {
    const file = source("app/orders/[id]/DocumentsSection.tsx").getFullText();
    expect(file).toContain("const printFromClick = useCallback((loadNumber?: number) => print(loadNumber, undefined, true), [print]);");
    expect(file).toContain("print: printFromClick,");
  });
});

/** The saved shipment's `printDoc`, closed over the real leaf, a fake window and spies (#692). */
function shipmentPrint(blocked = false) {
  const events: string[] = [];
  const w = fakeWindow(events, blocked);
  const answer = deferred<Response>();
  const trackedFetch = vi.fn((url: string, init?: RequestInit) => {
    events.push(`fetch ${init?.method} ${url}`);
    return answer.promise;
  });
  const setters = {
    setPrinting: vi.fn((value: boolean) => { events.push(`printing ${value}`); }),
    setPrintError: vi.fn((value: string | null) => { events.push(`error ${value}`); }),
    setCertDocIds: vi.fn(), setPrintWarnings: vi.fn(), setDocsRefresh: vi.fn(), setPrintedOrders: vi.fn(),
  };
  const printDoc = hookCallback<(query: string, label: string) => Promise<void>>(
    "app/shipping/[id]/ShipmentDetail.tsx", "ShipmentDetail", "printDoc", {
      id: "ship-1", window: w.win, openPendingTab, trackedFetch,
      invalidateHistory: () => { events.push("history"); },
      api: () => new Promise(() => {}), mergePrinted: (a: unknown) => a, ...setters,
    });
  return { printDoc, answer, events, tab: w.tab, ...setters };
}

describe("the saved shipment's prints (#692)", () => {
  it("opens the tab before the request is sent, and the stored copy shows in it", async () => {
    const p = shipmentPrint();
    const done = p.printDoc("doc=ticket", "ticket");
    expect(p.events).toEqual(['open "" _blank', "printing true", "error null", "fetch POST /api/shippers/ship-1/print?doc=ticket"]);
    const res = printed({ "x-document-id": "doc-3", "x-cert-document-ids": "c1,c2" });
    p.answer.resolve(res);
    await done;
    expect(p.events.slice(4)).toEqual(["history", "replace http://192.0.2.10/api/documents/doc-3", "printing false"]);
    expect(p.setCertDocIds.mock.calls.at(-1)).toEqual([["c1", "c2"]]);
    expect(p.tab.close).not.toHaveBeenCalled();
    expect(res.bodyUsed).toBe(true);
  });

  it("a refused print closes the blank tab and shows the server's sentence", async () => {
    const p = shipmentPrint();
    const done = p.printDoc("doc=bol", "bill of lading");
    p.answer.resolve(new Response(JSON.stringify({ error: "Shipment is voided" }), { status: 400 }));
    await done;
    expect(p.tab.close).toHaveBeenCalled();
    expect(p.setPrintError.mock.calls.at(-1)).toEqual(["Shipment is voided"]);
  });

  it("a blocked tab names the document and where it was archived", async () => {
    const p = shipmentPrint(true);
    const done = p.printDoc("doc=bol", "bill of lading");
    p.answer.resolve(printed({ "x-document-id": "doc-3" }));
    await done;
    expect(p.setPrintError.mock.calls.at(-1))
      .toEqual(["The browser blocked the print window — the bill of lading was archived and is in Documents below."]);
  });
});
