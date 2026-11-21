import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../src/lib/fetcher";
import { acceptPreview } from "../src/lib/process-preview-state";
import { PreviewDenied, SAMPLE_NO_ORDERS_VIEW, contextKeyOf, readPreviewResponse, type PreviewContext } from "../src/lib/process-preview-plan";
import { ProcessPreviewDialog } from "../src/app/parts/[id]/ProcessPreviewDialog";

const document = { expectedBaselineToken: "token", steps: [] };
const ALL = ["parts.view", "processes.view", "orders.view"];
const A: PreviewContext = { orderId: "order-1200", orderNumber: 1200, loadNumber: 1 };
const B: PreviewContext = { orderId: "order-1200", orderNumber: 1200, loadNumber: 2 };
function render(props: Partial<Parameters<typeof ProcessPreviewDialog>[0]> = {}) {
  return renderToStaticMarkup(<ProcessPreviewDialog open onClose={() => {}} partId="part" document={document} permissions={ALL} generation={3} authorizationRevision={1} {...props} />);
}

describe("ProcessPreviewDialog — static markup (spec 2026-09-26 §5)", () => {
  it("is a native dialog labelled Traveler preview, closed until opened, with the banner, Close and Refresh preview", () => {
    const html = render({ open: false });
    expect(html).toMatch(/^<dialog\b[^>]*aria-label="Traveler preview"/); expect(html).not.toMatch(/<dialog\b[^>]*\bopen\b/);
    expect(html).toContain("DRAFT PROCESS PREVIEW - NOT FOR PRODUCTION"); expect(html).toContain("<h3");
    expect(html).toMatch(/<button\b[^>]*>Close<\/button>/); expect(html).toMatch(/<button\b[^>]*>Refresh preview<\/button>/);
    // Closed, the SAMPLE path — the one that needs no context read — still offers no render: the
    // component gates on `open` itself, not only through the list it never requested.
    expect(render({ open: false, permissions: ["parts.view", "processes.view"] })).not.toContain("Updating preview…");
  });
  it("with orders.view offers the exact-number search and the Order and load picker, disabled until the list answers", () => {
    const html = render();
    expect(html).toContain("Find existing order"); expect(html).toContain('placeholder="Order number"');
    expect(html.match(/<select\b[^>]*aria-label="Order and load"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html).toContain("Checking preview contexts…"); expect(html).not.toContain("Updating preview…");
  });
  it("without orders.view offers no picker, says why the header is a SAMPLE, and renders straight away", () => {
    const html = render({ permissions: ["parts.view", "processes.view"] });
    expect(html).not.toContain("Order and load"); expect(html).not.toContain("Find existing order");
    expect(html).toContain(SAMPLE_NO_ORDERS_VIEW); expect(html).toContain("Updating preview…");
  });
  it("without parts.view or processes.view says what is required, disables Refresh preview and renders nothing", () => {
    for (const permissions of [["processes.view", "orders.view"], ["parts.view", "orders.view"]]) {
      const html = render({ permissions });
      expect(html).toContain("Preview requires current parts and processes view access.");
      expect(html.match(/<button\b[^>]*>Refresh preview<\/button>/)?.[0]).toContain('disabled=""');
      expect(html).not.toContain("Updating preview…");
    }
  });
  it("shows an unavailable reason instead of rendering", () => {
    const html = render({ permissions: ["parts.view", "processes.view"], unavailableReason: "Refresh process access before previewing." });
    expect(html).toContain("Refresh process access before previewing."); expect(html).not.toContain("Updating preview…");
  });
});

// ------------------------------------------------------------------------------------------------
// The effects, executed: the request discipline carried over from the side panel cannot be seen
// in static markup, so each effect's real callback runs against a bound environment (the
// `task-8-callbacks` technique), and a mutation of a guard reds the case that names it.
// ------------------------------------------------------------------------------------------------
const FILE = "../src/app/parts/[id]/ProcessPreviewDialog.tsx";
const source = ts.createSourceFile(FILE, readFileSync(new URL(FILE, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const text = (n: ts.Node) => n.getText(source).replace(/\s+/g, "");
function bind<T>(node: ts.Node, environment: Record<string, unknown>): T {
  const code = ts.transpileModule(`return (${node.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T;
}
/** The callback of the `useEffect` whose dependency list reads exactly `deps`. */
function effect(deps: string, environment: Record<string, unknown>): () => (() => void) | void {
  const calls: ts.CallExpression[] = [];
  const walk = (n: ts.Node) => { if (ts.isCallExpression(n) && text(n.expression) === "useEffect") calls.push(n); ts.forEachChild(n, walk); }; walk(source);
  const found = calls.filter(c => c.arguments[1] && text(c.arguments[1]) === deps);
  expect(found, `one useEffect with deps ${deps}`).toHaveLength(1);
  return bind(found[0].arguments[0], environment);
}
/** The callback of `const <name> = useCallback(fn, …)`. */
function callback<T>(name: string, environment: Record<string, unknown>): T {
  let found: ts.Expression | undefined;
  const walk = (n: ts.Node) => { if (ts.isVariableDeclaration(n) && n.name.getText(source) === name && n.initializer && ts.isCallExpression(n.initializer)) found = n.initializer.arguments[0]; ts.forEachChild(n, walk); }; walk(source);
  expect(found, name).toBeDefined(); return bind(found!, environment);
}
const session = { readAuthorizationTicket: () => "ticket", isReadAuthorized: () => true, getReadAuthorizationRevision: () => 1 };
const pdfResponse = (generation: number, headers: Record<string, string> = {}, body = "%PDF-1.7 fixture", status = 200) => new Response(body, { status,
  headers: { "content-type": "application/pdf", "X-Preview-Page-Count": "2", "X-Preview-Generation": String(generation), "X-Preview-Template-Name": encodeURIComponent("Standard traveler"),
    "X-Preview-Template-Id": "template", "X-Preview-Sample": "0", ...headers } });
const CONTEXTS_DEPS = "[open,ordersAllowed,partId,query,cursor,refresh,authorizationRevision,listKey]";
const RENDER_DEPS = "[available,context,payload,contextKey,authorizationRevision,partId,clearUrl,drain]";

describe("ProcessPreviewDialog — the element and the request follow `open`", () => {
  const run = (open: boolean, el: { open: boolean; showModal: () => void; close: () => void } | null, controller: { current: { abort: () => void } | null } = { current: null }) =>
    effect("[open]", { open, dialogRef: { current: el }, controller })();
  it("opens with showModal() once, closes with close(), and returns no cleanup (pre-flight M12: the development double-run must not close it)", () => {
    const el = { open: false, showModal: vi.fn(() => { el.open = true; }), close: vi.fn(() => { el.open = false; }) };
    expect(run(true, el)).toBeUndefined(); expect(el.showModal).toHaveBeenCalledTimes(1);
    run(true, el); expect(el.showModal).toHaveBeenCalledTimes(1); // already open: a second showModal() would throw
    run(false, el); expect(el.close).toHaveBeenCalledTimes(1);
    run(false, el); expect(el.close).toHaveBeenCalledTimes(1);    // Escape already closed it natively
    expect(() => run(true, null)).not.toThrow();
  });
  it("closing abandons a render in flight; opening does not", () => {
    const abort = vi.fn(); const el = { open: true, showModal: vi.fn(), close: vi.fn() };
    run(true, { ...el, open: false }, { current: { abort } }); expect(abort).not.toHaveBeenCalled();
    run(false, el, { current: { abort } }); expect(abort).toHaveBeenCalledTimes(1);
  });
  it("the dialog's close event — Escape, Close and dialog.close() all fire it — calls onClose, so the parent's `open` follows the element (Codex, #361)", () => {
    const elements: ts.JsxOpeningElement[] = [];
    const walk = (n: ts.Node) => { if (ts.isJsxOpeningElement(n)) elements.push(n); ts.forEachChild(n, walk); }; walk(source);
    const dialog = elements.find(e => e.tagName.getText(source) === "dialog"); expect(dialog).toBeDefined();
    const onClose = dialog!.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(source) === "onClose");
    expect(onClose && text(onClose)).toBe("onClose={()=>onClose()}");
    const close = elements.find(e => ts.isJsxElement(e.parent) && e.parent.children.some(c => ts.isJsxText(c) && c.text.trim() === "Close"));
    expect(close && text(close.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(source) === "onClick")!)).toBe("onClick={()=>onClose()}");
  });
});

describe("ProcessPreviewDialog — the context list is read only while open, with orders.view", () => {
  function harness(over: Record<string, unknown> = {}) {
    const timers: Array<() => void> = [];
    const env = { getBrowserDraftSession: () => session, setContextRead: vi.fn(), setContextError: vi.fn(), setDenied: vi.fn(), setPreviewDenied: vi.fn(), open: true, ordersAllowed: true,
      setTimeout: vi.fn((fn: () => void) => { timers.push(fn); return timers.length; }), clearTimeout: vi.fn(), URLSearchParams, query: "", cursor: null,
      api: vi.fn(async (): Promise<unknown> => ({ items: [A, B], nextCursor: null })), partId: "part", setContexts: vi.fn(), listKey: "part:1:::0", setSelected: vi.fn(), contextKeyOf, ApiError,
      listedQuery: { current: null as string | null }, ...over };
    return { env, timers, run: () => effect(CONTEXTS_DEPS, env)() };
  }
  it("closed, or without orders.view, never requests the list (pre-flight M8) — but still clears a refusal so Retry can start over", () => {
    for (const over of [{ open: false }, { ordersAllowed: false }]) {
      const h = harness(over); h.run();
      expect(h.env.setTimeout).not.toHaveBeenCalled(); expect(h.env.api).not.toHaveBeenCalled();
      expect(h.env.setPreviewDenied).toHaveBeenCalledWith(false); expect(h.env.setDenied).toHaveBeenCalledWith(false);
    }
  });
  it("open: reads the list at once, records it under its key, and selects the first item unless the old selection is still listed", async () => {
    const h = harness(); const cleanup = h.run();
    expect(h.env.setTimeout).toHaveBeenCalledWith(expect.any(Function), 0); h.timers[0]();
    await vi.waitFor(() => expect(h.env.setContextRead).toHaveBeenCalledWith("part:1:::0"));
    expect(h.env.api).toHaveBeenCalledWith("/api/parts/part/process/preview-contexts?q=");
    expect(h.env.setContexts).toHaveBeenCalledWith({ items: [A, B], nextCursor: null });
    const updater = h.env.setSelected.mock.calls[0][0] as (old: string) => string;
    expect(updater("")).toBe(contextKeyOf(A)); expect(updater(contextKeyOf(B))).toBe(contextKeyOf(B)); expect(updater("gone:1")).toBe(contextKeyOf(A));
    cleanup?.(); expect(h.env.clearTimeout).toHaveBeenCalledWith(1);
  });
  it("only a changed search waits out the 200 ms debounce; opening, Refresh and a page go at once, and closing forgets the search (#660)", () => {
    const listedQuery = { current: null as string | null };
    const delays = (over: Record<string, unknown>) => { const h = harness({ listedQuery, ...over }); h.run(); return h.env.setTimeout.mock.calls.map(c => (c as unknown[])[1]); };
    expect(delays({ query: "" })).toEqual([0]);                 // opened
    expect(delays({ query: "" })).toEqual([0]);                 // Refresh, or the development double run
    expect(delays({ query: "12" })).toEqual([200]);             // a keystroke
    expect(delays({ query: "12", cursor: "abc" })).toEqual([0]); // the next page of the same search
    expect(delays({ query: "12", open: false })).toEqual([]);
    expect(delays({ query: "" })).toEqual([0]);                 // reopened with the search cleared
  });
  it("carries the search and the cursor", () => {
    const h = harness({ query: "1200", cursor: "abc" }); h.run(); h.timers[0]();
    expect(h.env.api).toHaveBeenCalledWith("/api/parts/part/process/preview-contexts?q=1200&cursor=abc");
  });
  it("a refusal of the list (401/403) falls to the SAMPLE path, never an error; any other failure is the error Retry preview clears", async () => {
    const denied = harness({ api: vi.fn(async () => { throw new ApiError("Forbidden", 403); }) }); denied.run(); denied.timers[0]();
    await vi.waitFor(() => expect(denied.env.setDenied).toHaveBeenLastCalledWith(true));
    expect(denied.env.setContextError).not.toHaveBeenCalledWith(expect.any(String));
    const failed = harness({ api: vi.fn(async () => { throw new ApiError("Request failed (500)", 500); }) }); failed.run(); failed.timers[0]();
    await vi.waitFor(() => expect(failed.env.setContextError).toHaveBeenLastCalledWith("Request failed (500)"));
    expect(failed.env.setDenied).not.toHaveBeenCalledWith(true);
  });
  it("a list that lands after the effect was superseded is dropped", async () => {
    const h = harness(); const cleanup = h.run(); cleanup?.(); h.timers[0]();
    await vi.waitFor(() => expect(h.env.api).toHaveBeenCalledTimes(1));
    await Promise.resolve(); await Promise.resolve();
    expect(h.env.setContexts).not.toHaveBeenCalled(); expect(h.env.setContextRead).not.toHaveBeenCalledWith("part:1:::0");
  });
});

describe("ProcessPreviewDialog — one render at a time, only while available, and a stale answer never lands", () => {
  function harness(over: Record<string, unknown> = {}) {
    const timers: Array<() => void> = []; const queued = { current: null as (() => Promise<void>) | null }; const running = { current: false };
    const drain = callback<() => Promise<void>>("drain", { running, queued });
    const env = { clearUrl: vi.fn(), queued, expected: { current: null as unknown }, getBrowserDraftSession: () => session, available: true, context: A as PreviewContext | null, dispatch: vi.fn(),
      sequence: { current: 6 }, contextKey: "key", authorizationRevision: 1, acceptPreview, setTimeout: vi.fn((fn: () => void) => { timers.push(fn); return timers.length; }), clearTimeout: vi.fn(),
      trackedFetch: vi.fn(async (): Promise<Response> => pdfResponse(7)), partId: "part", payload: JSON.stringify(document), controller: { current: null as AbortController | null },
      readPreviewResponse, PreviewDenied, setPreviewDenied: vi.fn(), URL: { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }, objectUrl: { current: null as string | null }, drain,
      renderedPayload: { current: null as string | null }, ...over };
    return { env, timers, running, run: () => effect(RENDER_DEPS, env)() };
  }
  const identity = { generation: 7, contextKey: "key", authorizationRevision: 1 };
  it("not available — closed, no document, no target, an unavailable reason — schedules nothing and shows nothing", () => {
    const h = harness({ available: false }); h.run();
    expect(h.env.dispatch).toHaveBeenCalledWith({ type: "unavailable" }); expect(h.env.setTimeout).not.toHaveBeenCalled(); expect(h.env.trackedFetch).not.toHaveBeenCalled();
    expect(h.env.expected.current).toBeNull();
  });
  it("only a changed draft waits out the 400 ms debounce; opening, a context and Refresh render at once, and closing forgets the draft (#660)", () => {
    const renderedPayload = { current: null as string | null };
    const delays = (over: Record<string, unknown>) => { const h = harness({ renderedPayload, ...over }); h.run(); return h.env.setTimeout.mock.calls.map(c => (c as unknown[])[1]); };
    expect(delays({})).toEqual([0]);                                   // opened
    expect(delays({ contextKey: "other", context: B })).toEqual([0]);  // a picked context, or Refresh
    expect(delays({ payload: JSON.stringify({ ...document, steps: [] , x: 1 }) })).toEqual([400]);
    expect(delays({ available: false })).toEqual([]);
    expect(delays({})).toEqual([0]);                                   // reopened
  });
  it("available: at once ONE POST carries the document, the context and this generation, and a valid PDF lands as ready", async () => {
    const h = harness(); h.run();
    expect(h.env.dispatch).toHaveBeenCalledWith({ type: "change", identity }); expect(h.env.expected.current).toEqual(identity);
    expect(h.env.setTimeout).toHaveBeenCalledWith(expect.any(Function), 0); h.timers[0]();
    await vi.waitFor(() => expect(h.env.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "ready" })));
    expect(h.env.trackedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.env.trackedFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/parts/part/process/preview"); expect(init.method).toBe("POST"); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({ expectedBaselineToken: "token", steps: [], context: A, generation: 7 });
    expect(h.env.dispatch).toHaveBeenLastCalledWith({ type: "ready", identity, url: "blob:preview", pages: 2, templateName: "Standard traveler", renderedAt: expect.any(Number) });
    expect(h.env.objectUrl.current).toBe("blob:preview"); expect(h.env.controller.current).toBeNull(); expect(h.running.current).toBe(false);
  });
  it("a SAMPLE sends `context: null`, never an invented order", async () => {
    const h = harness({ context: null }); h.run(); h.timers[0]();
    await vi.waitFor(() => expect(h.env.trackedFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse((h.env.trackedFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ context: null, generation: 7 });
  });
  it("an answer for an identity that is no longer expected — a newer edit, context or a closed dialog — never replaces the newer one, and its bytes are never even read", async () => {
    let release!: (r: Response) => void; const held = new Promise<Response>(yes => { release = yes; });
    const read = vi.fn(readPreviewResponse);
    const h = harness({ trackedFetch: vi.fn(() => held), readPreviewResponse: read }); h.run(); h.timers[0]();
    await vi.waitFor(() => expect(h.env.trackedFetch).toHaveBeenCalledTimes(1));
    h.env.expected.current = { ...identity, generation: 8 }; // the next effect run took over
    release(pdfResponse(7)); await Promise.resolve(); await new Promise(r => setTimeout(r, 0));
    expect(h.env.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ready" }));
    expect(h.env.URL.createObjectURL).not.toHaveBeenCalled();
    expect(read, "a discarded answer's PDF body is not read into memory").not.toHaveBeenCalled();
  });
  it("...and one that moves on while the bytes are still being read is dropped by the second check, before any object URL exists", async () => {
    const h = harness(); const moved = { ...identity, generation: 8 };
    h.env.readPreviewResponse = async (response: Response, generation: number) => { h.env.expected.current = moved; return readPreviewResponse(response, generation); };
    h.run(); h.timers[0]();
    await vi.waitFor(() => expect(h.env.trackedFetch).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
    expect(h.env.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ready" }));
    expect(h.env.URL.createObjectURL).not.toHaveBeenCalled(); expect(h.env.objectUrl.current).toBeNull();
  });
  it("the cleanup abandons queued work, the expected identity and the object URL, so a stale timer cannot request", () => {
    const h = harness(); const cleanup = h.run(); expect(cleanup).toBeTypeOf("function");
    h.env.queued.current = async () => {}; cleanup!();
    expect(h.env.clearTimeout).toHaveBeenCalledWith(1); expect(h.env.queued.current).toBeNull(); expect(h.env.expected.current).toBeNull(); expect(h.env.clearUrl).toHaveBeenCalledTimes(2);
  });
  it("a refusal (401/403) marks the preview denied and shows nothing; an invalid answer reports the retry message", async () => {
    const denied = harness({ trackedFetch: vi.fn(async () => new Response("", { status: 403 })) }); denied.run(); denied.timers[0]();
    await vi.waitFor(() => expect(denied.env.setPreviewDenied).toHaveBeenCalledWith(true));
    expect(denied.env.dispatch).toHaveBeenLastCalledWith({ type: "unavailable" }); expect(denied.env.expected.current).toBeNull();
    const invalid = harness({ trackedFetch: vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) }); invalid.run(); invalid.timers[0]();
    await vi.waitFor(() => expect(invalid.env.dispatch).toHaveBeenLastCalledWith({ type: "error", identity, message: "The server returned an invalid PDF preview. Retry the preview." }));
    expect(invalid.env.setPreviewDenied).not.toHaveBeenCalled();
  });
  it("the queue runs one job at a time and drains the newest queued job after it", async () => {
    const queued = { current: null as (() => Promise<void>) | null }; const running = { current: false };
    const drain = callback<() => Promise<void>>("drain", { running, queued });
    const order: string[] = []; let release!: () => void; const held = new Promise<void>(yes => { release = yes; });
    queued.current = async () => { order.push("first:start"); await held; order.push("first:end"); };
    const first = drain(); expect(running.current).toBe(true); expect(queued.current).toBeNull();
    queued.current = async () => { order.push("second"); };
    void drain(); expect(order).toEqual(["first:start"]); // refused while the first runs
    release(); await first; await new Promise(r => setTimeout(r, 0));
    expect(order).toEqual(["first:start", "first:end", "second"]); expect(running.current).toBe(false); expect(queued.current).toBeNull();
  });
});
