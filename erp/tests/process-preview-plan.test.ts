import { describe, expect, it } from "vitest";
import {
  PREVIEW_VIEW_PERMISSIONS, PreviewDenied, SAMPLE_NO_ORDER, SAMPLE_NO_ORDERS_VIEW, contextKeyOf, previewAvailable, readPreviewResponse, resolvePreviewTarget,
  type PreviewContext, type PreviewTarget,
} from "../src/lib/process-preview-plan";

const A: PreviewContext = { orderId: "order-1200", orderNumber: 1200, loadNumber: 1 };
const B: PreviewContext = { orderId: "order-1200", orderNumber: 1200, loadNumber: 2 };
const listed = { ordersAllowed: true, error: null, listed: true, items: [A, B], selected: "", filtered: false, query: "" };

describe("resolvePreviewTarget — which header the preview renders around the draft (spec 2026-09-26 §5)", () => {
  it("without orders.view the preview is a SAMPLE with that reason, whatever the list would hold", () => {
    expect(resolvePreviewTarget({ ...listed, ordersAllowed: false })).toEqual({ kind: "sample", reason: SAMPLE_NO_ORDERS_VIEW });
    expect(SAMPLE_NO_ORDERS_VIEW).toBe("A real order needs orders.view access, so this preview has a SAMPLE header.");
  });
  it("a list that failed renders nothing and says why; one still loading is pending", () => {
    expect(resolvePreviewTarget({ ...listed, error: "Request failed (500)" })).toEqual({ kind: "none", reason: "Request failed (500)" });
    expect(resolvePreviewTarget({ ...listed, listed: false })).toEqual({ kind: "pending" });
  });
  it("the first item (the newest order, its lowest load) is the default; a selection present in the list wins; a stale one falls back", () => {
    expect(resolvePreviewTarget(listed)).toEqual({ kind: "order", context: A });
    expect(resolvePreviewTarget({ ...listed, selected: contextKeyOf(B) })).toEqual({ kind: "order", context: B });
    expect(resolvePreviewTarget({ ...listed, selected: "order-9:9" })).toEqual({ kind: "order", context: A });
    expect(contextKeyOf(B)).toBe("order-1200:2");
  });
  it("an empty UNFILTERED list means no eligible order: a SAMPLE with that reason", () => {
    expect(resolvePreviewTarget({ ...listed, items: [] })).toEqual({ kind: "sample", reason: SAMPLE_NO_ORDER });
    // The owner's wording (2026-09-27): the list holds only orders with a load, so "no saved order"
    // was untrue for a lead-part order that has none yet.
    expect(SAMPLE_NO_ORDER).toBe("No order for this part has a load yet, so this preview has a SAMPLE header.");
  });
  it("an empty search result or a later page is not a SAMPLE (pre-flight M13): nothing renders, and the text says what was looked for", () => {
    expect(resolvePreviewTarget({ ...listed, items: [], filtered: true, query: "1200" })).toEqual({ kind: "none", reason: "No saved order 1200 leads with this part and has a load." });
    expect(resolvePreviewTarget({ ...listed, items: [], filtered: true, query: "" })).toEqual({ kind: "none", reason: "No more orders." });
  });
});

describe("previewAvailable — when a render may be requested at all", () => {
  const base = { open: true, viewAllowed: true, denied: false, target: { kind: "order", context: A } as PreviewTarget, hasDocument: true, unavailableReason: undefined };
  it("is true only while the dialog is open: no request on page load, on an edit while closed, or after Escape (pre-flight M8)", () => {
    expect(previewAvailable(base)).toBe(true);
    expect(previewAvailable({ ...base, open: false })).toBe(false);
  });
  it("needs parts.view and processes.view, a document, no refusal, no unavailable reason and a resolved target (order or SAMPLE)", () => {
    expect(PREVIEW_VIEW_PERMISSIONS).toEqual(["parts.view", "processes.view"]);
    expect(previewAvailable({ ...base, viewAllowed: false })).toBe(false);
    expect(previewAvailable({ ...base, denied: true })).toBe(false);
    expect(previewAvailable({ ...base, hasDocument: false })).toBe(false);
    expect(previewAvailable({ ...base, unavailableReason: "Refresh process access before previewing." })).toBe(false);
    expect(previewAvailable({ ...base, target: { kind: "pending" } })).toBe(false);
    expect(previewAvailable({ ...base, target: { kind: "none", reason: "No more orders." } })).toBe(false);
    expect(previewAvailable({ ...base, target: { kind: "sample", reason: SAMPLE_NO_ORDER } })).toBe(true);
  });
});

describe("readPreviewResponse — the checks carried over from the side panel", () => {
  const pdf = (headers: Record<string, string> = {}, init: { status?: number; body?: string } = {}) => new Response(init.body ?? "%PDF-1.7 fixture", {
    status: init.status ?? 200,
    headers: { "content-type": "application/pdf", "X-Preview-Page-Count": "2", "X-Preview-Generation": "7", "X-Preview-Template-Name": encodeURIComponent("Standard traveler"),
      "X-Preview-Template-Id": "template", "X-Preview-Sample": "1", ...headers },
  });
  it("accepts a PDF whose headers carry this generation, a page count and the template identity", async () => {
    const result = await readPreviewResponse(pdf(), 7);
    expect(result.pages).toBe(2); expect(result.templateName).toBe("Standard traveler"); expect(result.sample).toBe(true);
    expect(await result.blob.text()).toBe("%PDF-1.7 fixture");
    expect((await readPreviewResponse(pdf({ "X-Preview-Sample": "0" }), 7)).sample).toBe(false);
  });
  it("401 and 403 refuse the caller — its own kind, so the dialog can say so rather than offer a retry", async () => {
    await expect(readPreviewResponse(pdf({}, { status: 403, body: '{"error":"Previewing an order needs orders.view access"}' }), 7)).rejects.toBeInstanceOf(PreviewDenied);
    await expect(readPreviewResponse(pdf({}, { status: 401, body: "" }), 7)).rejects.toBeInstanceOf(PreviewDenied);
  });
  it("a failed status carries the server's message, or a generic one", async () => {
    await expect(readPreviewResponse(new Response('{"error":"Part not found"}', { status: 404 }), 7)).rejects.toThrow("Part not found");
    await expect(readPreviewResponse(new Response("", { status: 500 }), 7)).rejects.toThrow("Preview failed (500)");
  });
  it("a stale generation, a non-PDF body type or a bad page count is an invalid preview with the retry message", async () => {
    const invalid = "The server returned an invalid PDF preview. Retry the preview.";
    await expect(readPreviewResponse(pdf({ "X-Preview-Generation": "6" }), 7)).rejects.toThrow(invalid);
    await expect(readPreviewResponse(pdf({ "content-type": "application/json" }, { body: "{}" }), 7)).rejects.toThrow(invalid);
    await expect(readPreviewResponse(pdf({ "X-Preview-Page-Count": "0" }), 7)).rejects.toThrow(invalid);
    await expect(readPreviewResponse(pdf({ "X-Preview-Page-Count": "many" }), 7)).rejects.toThrow(invalid);
    await expect(readPreviewResponse(pdf({ "content-type": "application/pdf; charset=binary" }), 7)).resolves.toMatchObject({ pages: 2 });
  });
  it("a missing template identity has its own message, and bytes that are not a PDF are invalid", async () => {
    await expect(readPreviewResponse(pdf({ "X-Preview-Template-Name": "" }), 7)).rejects.toThrow("The preview template could not be identified.");
    await expect(readPreviewResponse(pdf({ "X-Preview-Template-Id": "" }), 7)).rejects.toThrow("The preview template could not be identified.");
    await expect(readPreviewResponse(pdf({}, { body: "<html>not a pdf</html>" }), 7)).rejects.toThrow("The server returned an invalid PDF preview.");
  });
});
