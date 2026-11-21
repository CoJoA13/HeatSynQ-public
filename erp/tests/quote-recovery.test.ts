import { readFileSync } from "node:fs";
import ts from "typescript";
import { gate } from "../src/lib/permission-ui";
import { ApiError, UnreadableAnswerError, WRITE_ANSWER_UNREADABLE } from "../src/lib/fetcher";
import { describe, expect, it, vi } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { oneShotHold } from "../src/lib/single-flight";
import { retainBreakDrafts, priceKeysOf } from "../src/lib/break-drafts";
import { headerFormFrom, lineFormsFrom, type QuoteDetailData } from "../src/app/quotes/quote-form";
import {
  quoteBaselineFrom, quoteDraftFrom, quoteRecoveryAdapter, quoteSaveDirty, prepareQuoteSave,
  addQuoteLine, addQuotePrice, addQuoteBreak, removeQuoteLine, removeQuotePrice,
  runQuoteSave, runQuoteNative, runQuoteDelete, type QuoteRecoveryCatalogs,
} from "../src/lib/quote-recovery";

const catalogs: QuoteRecoveryCatalogs = {
  permissions: ["quotes.edit", "quotes.view", "parts.view", "customers.view", "action.manage_users"],
  contacts: [{ id: "contact-a", name: "Pat Example", active: true }],
  users: [{ id: "user-a", displayName: "Quinn Example", active: true }],
  statements: [{ id: "statement-a", name: "Standard terms", active: true }],
  steps: [{ id: "step-a", name: "HT", active: true }],
  parts: [{ id: "part-a", customerId: "customer-a", partNumber: "P-10", name: "Bracket", active: true }],
  materials: [{ id: "material-a", name: "4140", active: true }],
};
function detail(): QuoteDetailData {
  return {
    id: "quote-a", quoteNumber: 101, status: "OPEN", expired: false, customerId: "customer-a", customerCode: "ACME", customerName: "Example Company",
    contactId: "contact-a", contactName: "Pat Example", quoteDate: "2026-09-12", effectiveDate: "2026-09-12", expiryDate: "2026-10-12", followUpDate: null,
    rfqNumber: "Saved RFQ", quotedById: "user-a", quotedByName: "Quinn Example", endingStatementId: "statement-a", endingStatementName: "Standard terms", endingStatementText: "Terms",
    closeReason: "", closedAt: null, closedByName: "", notes: "Saved notes", internalNotes: "Saved private notes", deletedAt: null,
    lines: [{ id: "line-a", position: 1, partId: null, partNumber: "RAW-10", partName: "Raw bracket", partDescription: "Description", material: "Steel", materialId: null, materialText: "Steel", partMaterialId: null, eachWeight: 1.25,
      quotedQty: 10, quotedUnlimited: false, linkedOrderCount: 0, linkedOrders: [], prices: [
        { id: "price-a", processStepCodeId: "step-a", stepCode: "HT", stepName: "Heat treat", position: 1, setupCharge: 5, unitPrice: 2.5, minimumCharge: null,
          pricePer: "EACH", notes: "Process notes", breaks: [{ id: "break-a", threshold: 100, price: 2 }] },
      ] }],
  };
}
function openQuote() {
  const baseline = quoteBaselineFrom(detail(), catalogs); const clean = quoteDraftFrom(baseline);
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const binding = store.bind({ owner, record: { kind: "quote", id: "quote-a" }, editor: quoteRecoveryAdapter.kind }, { label: "Quote", href: "/quotes/quote-a" }, quoteRecoveryAdapter);
  const detach = binding.attach("first"); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
  return { binding, store, baseline, clean, detach };
}

describe("quote recovery", () => {
  it("restores raw header, ordered tree, unadded break and key sequence from one last event", () => {
    const { binding, baseline, clean, detach } = openQuote();
    binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "Last RFQ", notes: "", internalNotes: "private raw" }, seq: 9,
      lines: [{ ...d.lines[0], quotedQty: "bad", prices: [{ ...d.lines[0].prices[0], unitPrice: "", breaks: [{ key: "new-9", threshold: "00.50", price: "bad" }] }] }],
      breakDrafts: { "price-a": { threshold: "", price: "bad" } } }));
    detach(); binding.attach("return"); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    expect(binding.getSnapshot().mode).toBe("offer"); expect(binding.restore(binding.getSnapshot().current!.stamp, readId)).toBe(true);
    const recovered = binding.getSnapshot().current!.data;
    expect(recovered.header).toMatchObject({ rfqNumber: "Last RFQ", notes: "", internalNotes: "private raw" });
    expect(recovered.breakDrafts["price-a"]).toEqual({ threshold: "", price: "bad" });
    expect(recovered.lines[0].prices[0].key).toBe("price-a"); expect(recovered.seq).toBe(9);
    expect(recovered.lines[0].prices[0].breaks).toEqual([{ key: "new-9", threshold: "00.50", price: "bad" }]);
  });
  it("allocates new keys atomically from the recovered sequence for each row type", () => {
    const { binding, baseline, clean, detach } = openQuote();
    binding.change(d => ({ ...d, seq: 9, breakDrafts: { "price-a": { threshold: "10", price: "raw-price" } } }));
    detach(); binding.attach("return"); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    binding.restore(binding.getSnapshot().current!.stamp, readId);
    binding.change(addQuoteLine); binding.change(d => addQuotePrice(d, "new-10", "step-a", "HT"));
    binding.change(d => addQuoteBreak(d, "line-a", "price-a"));
    const result = binding.getSnapshot().current!.data;
    expect(result.lines[1].key).toBe("new-10"); expect(result.lines[1].prices[0].key).toBe("new-11");
    expect(result.lines[0].prices[0].breaks[1]).toEqual({ key: "new-12", threshold: "10", price: "raw-price" });
    expect(result.seq).toBe(12); expect(result.breakDrafts).toEqual({});
    expect(clean.seq).toBe(0); expect(clean.lines).toHaveLength(1);
  });
  for (const change of ["added-price", "removed-break", "changed-price", "reidentified-break", "position", "linked-order", "part", "material", "status", "deleted", "customer"] as const) it(`conflicts on fresh writer change: ${change}`, () => {
    const { binding, detach } = openQuote(); binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "Only header changed" } }));
    const fresh = detail();
    if (change === "added-price") fresh.lines[0].prices.push({ ...fresh.lines[0].prices[0], id: "price-b", position: 2, breaks: [] });
    if (change === "removed-break") fresh.lines[0].prices[0].breaks = [];
    if (change === "changed-price") fresh.lines[0].prices[0].unitPrice = 3;
    if (change === "reidentified-break") fresh.lines[0].prices[0].breaks[0].id = "break-replaced";
    if (change === "position") fresh.lines[0].prices[0].position = 2;
    if (change === "linked-order") { fresh.lines[0].linkedOrderCount = 1; fresh.lines[0].linkedOrders = [{ id: "order-a", orderNumber: 201 }]; }
    if (change === "part") fresh.lines[0].partId = "part-a";
    if (change === "material") { fresh.lines[0].materialId = "material-a"; fresh.lines[0].materialText = ""; }
    if (change === "status") fresh.status = "CLOSED";
    if (change === "deleted") fresh.deletedAt = "2026-09-12T12:00:00Z";
    if (change === "customer") fresh.customerId = "customer-b";
    detach(); binding.attach("return"); const readId = binding.beginRead(); const baseline = quoteBaselineFrom(fresh, catalogs);
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, quoteDraftFrom(baseline));
    expect(binding.getSnapshot().mode).toBe("conflict"); expect(binding.getSnapshot().canRestore).toBe(false);
    expect(binding.getSnapshot().current?.data.header.rfqNumber).toBe("Only header changed");
  });
  it("a change to the Materials pick list raises no conflict over a dirty draft (#541: display data, out of the comparison)", () => {
    const { binding, detach } = openQuote(); binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "Only header changed" } }));
    expect(quoteRecoveryAdapter.baselineEqual(quoteBaselineFrom(detail(), catalogs), quoteBaselineFrom(detail(), { ...catalogs, materials: null }))).toBe(true);
    detach(); binding.attach("return"); const readId = binding.beginRead();
    const baseline = quoteBaselineFrom(detail(), { ...catalogs, materials: [{ id: "material-a", name: "4140 HT", active: false }, { id: "material-b", name: "8620", active: true }] });
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, quoteDraftFrom(baseline));
    expect(binding.getSnapshot().mode).toBe("offer");
  });
  it("a recovered draft's preview names the picked material, or says it is unavailable, and keeps typed text (#541)", () => {
    const baseline = quoteBaselineFrom(detail(), catalogs); const clean = quoteDraftFrom(baseline);
    const material = (data: typeof clean, b = baseline) => quoteRecoveryAdapter.preview(data, b).find(f => f.label === "Line 1 material")?.value;
    expect(material(clean)).toBe("Steel");
    const picked = { ...clean, lines: [{ ...clean.lines[0], materialId: "material-a", materialText: "" }] };
    expect(quoteRecoveryAdapter.valid(picked, baseline)).toBe(true);
    expect(material(picked)).toBe("4140");
    expect(material(picked, { ...baseline, catalogs: { ...baseline.catalogs, materials: null } })).toBe("Unavailable selection");
    // A draft line without the key (an older shape) still reads cleanly, as no material.
    const { materialId: _drop, ...older } = clean.lines[0]; void _drop;
    expect(quoteRecoveryAdapter.valid({ ...clean, lines: [older as typeof clean.lines[0]] }, baseline)).toBe(true);
    expect(quoteRecoveryAdapter.dirty({ ...clean, lines: [older as typeof clean.lines[0]] }, baseline)).toBe(false);
    expect(quoteRecoveryAdapter.valid(clean, { ...baseline, catalogs: { ...baseline.catalogs, materials: [{ id: 1 }] } as never })).toBe(false);
    expect(quoteRecoveryAdapter.schema).toBe("quote-v2");
  });
  it("compares a baseline with itself without reading the parts catalog (#703: the same object after a read)", () => {
    const built = quoteBaselineFrom(detail(), catalogs);
    const trap = new Proxy([] as typeof built.catalogs.parts, { get() { throw new Error("parts catalog read"); } });
    const baseline = { ...built, catalogs: { ...built.catalogs, parts: trap } };
    expect(quoteRecoveryAdapter.baselineEqual(baseline, baseline)).toBe(true);
  });
  it("ignores linked part display changes while preserving dormant wire blanks and weight rules", () => {
    const first = detail(); first.lines[0].partId = "part-a";
    const second = detail(); second.lines[0].partId = "part-a"; second.lines[0].partNumber = "LIVE-RENAMED"; second.lines[0].partName = "New display"; second.lines[0].eachWeight = 9;
    expect(quoteRecoveryAdapter.baselineEqual(quoteBaselineFrom(first, catalogs), quoteBaselineFrom(second, catalogs))).toBe(true);
    const linked = quoteDraftFrom(quoteBaselineFrom(first, catalogs)); expect(linked.lines[0]).toMatchObject({ partNumberText: "", partNameText: "", eachWeight: "" });
    expect(quoteDraftFrom(quoteBaselineFrom(detail(), catalogs)).lines[0].eachWeight).toBe("1.25");
  });
  it("successful PATCH adopts header/tree wholesale and intersects current unadded breaks", () => {
    const { binding, store } = openQuote(); binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "Submitted" } }));
    const prepared = prepareQuoteSave(binding, "save"); expect(prepared.kind).toBe("ready"); if (prepared.kind !== "ready") return;
    expect(binding.dispatched(prepared.submission)).toBe(true);
    binding.change(d => ({ ...d, seq: 9, header: { ...d.header, rfqNumber: "Later edit consumed" }, lines: [{ ...d.lines[0], quotedQty: "777" }],
      breakDrafts: { "price-a": { threshold: "", price: "bad" }, "gone-price": { threshold: "6", price: "7" } } }));
    const response = detail(); response.rfqNumber = "Submitted";
    binding.settle(prepared.submission, { kind: "persisted", response });
    const adopted = binding.getSnapshot().current!.data;
    expect(adopted.header).toEqual(headerFormFrom(response)); expect(adopted.lines).toEqual(lineFormsFrom(response));
    expect(adopted.breakDrafts).toEqual({ "price-a": { threshold: "", price: "bad" } }); expect(adopted.seq).toBe(9);
    expect(store.getSnapshot().count).toBe(1);
    binding.settle(prepared.submission, { kind: "unknown" }); expect(binding.getSnapshot().current?.data).toBe(adopted);
  });
  it("keeps an unadded-only draft without capturing a save payload", () => {
    const { binding, store } = openQuote(); binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: "", price: "bad" } } }));
    const capture = vi.spyOn(binding, "capture"); expect(prepareQuoteSave(binding, "empty")).toEqual({ kind: "empty" });
    expect(capture).not.toHaveBeenCalled();
    expect(store.getSnapshot().count).toBe(1);
    expect(store.getSnapshot().rows).toHaveLength(1);
    expect(store.getSnapshot().rows[0].pending).toBe(false);
  });
  for (const invalid of ["date", "quantity", "blank-break"] as const) it(`refuses invalid ${invalid} before capture`, () => {
    const { binding, store } = openQuote(); binding.change(d => ({ ...d,
      header: { ...d.header, ...(invalid === "date" ? { quoteDate: "" } : {}) },
      lines: d.lines.map(l => ({ ...l, quotedQty: invalid === "quantity" ? "bad" : l.quotedQty,
        prices: l.prices.map(p => ({ ...p, breaks: p.breaks.map(b => ({ ...b, price: invalid === "blank-break" ? "" : b.price })) })) })),
    }));
    const capture = vi.spyOn(binding, "capture"); expect(prepareQuoteSave(binding, "invalid").kind).toBe("invalid");
    expect(capture).not.toHaveBeenCalled(); expect(store.getSnapshot().rows[0].pending).toBe(false);
  });
  it("lists every decimal refusal, one per line, before capture", () => {
    const { binding, store } = openQuote(); binding.change(d => ({ ...d, lines: [{ ...d.lines[0], eachWeight: "0",
      prices: [{ ...d.lines[0].prices[0], unitPrice: "$4.50" }] }] }));
    const capture = vi.spyOn(binding, "capture");
    expect(prepareQuoteSave(binding, "invalid")).toEqual({ kind: "invalid", error:
      "Line 1, Each weight (lb): must be greater than zero.\nLine 1, operation 1, Unit price: enter a number without $ or commas, such as 0.36." });
    expect(capture).not.toHaveBeenCalled(); expect(store.getSnapshot().rows[0].pending).toBe(false);
  });
  it("a recovered draft keeps a refused decimal's text and is refused at Save, never at restore", () => {
    // Review focus 3: recovery holds raw text; the decimal check belongs to Save alone.
    const { binding, baseline, clean, detach } = openQuote();
    binding.change(d => ({ ...d, lines: [{ ...d.lines[0], prices: [{ ...d.lines[0].prices[0], unitPrice: "not-a-unit-price" }] }] }));
    detach(); binding.attach("return"); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    expect(binding.getSnapshot().mode).toBe("offer"); expect(binding.restore(binding.getSnapshot().current!.stamp, readId)).toBe(true);
    expect(binding.getSnapshot().current!.data.lines[0].prices[0].unitPrice).toBe("not-a-unit-price");
    const capture = vi.spyOn(binding, "capture");
    expect(prepareQuoteSave(binding, "recovered")).toEqual({ kind: "invalid",
      error: "Line 1, operation 1, Unit price: enter a number without $ or commas, such as 0.36." });
    expect(capture).not.toHaveBeenCalled();
  });
  it("a header-only Save is never refused for a line's stored text", () => {
    // Lines the page would now refuse, identical in the baseline and the draft: the lines did not
    // change, so they are not checked and not sent (review focus 2).
    const loaded = quoteBaselineFrom(detail(), catalogs);
    const baseline = { ...loaded, lines: loaded.lines.map(l => ({ ...l, prices: l.prices.map(p => ({ ...p, unitPrice: "abc" })) })) };
    const clean = quoteDraftFrom(baseline);
    const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
    const binding = store.bind({ owner, record: { kind: "quote", id: "quote-a" }, editor: quoteRecoveryAdapter.kind }, { label: "Quote", href: "/quotes/quote-a" }, quoteRecoveryAdapter);
    binding.attach("first"); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "Header only" } }));
    const prepared = prepareQuoteSave(binding, "header"); expect(prepared.kind).toBe("ready"); if (prepared.kind !== "ready") return;
    expect(prepared.submission.payload).toEqual({ rfqNumber: "Header only" });
  });
  it("known rejection retains current raw decimal text and unknown result never restores automatically", () => {
    // " 4.50 " passes the page's check (the server trims), so the write is sent and rejected there.
    const { binding } = openQuote(); binding.change(d => ({ ...d, lines: [{ ...d.lines[0], prices: [{ ...d.lines[0].prices[0], unitPrice: " 4.50 " }] }] }));
    const prepared = prepareQuoteSave(binding, "rejected"); expect(prepared.kind).toBe("ready"); if (prepared.kind !== "ready") return;
    binding.dispatched(prepared.submission); binding.settle(prepared.submission, { kind: "rejected" });
    expect(binding.getSnapshot().current?.data.lines[0].prices[0].unitPrice).toBe(" 4.50 ");
    const next = prepareQuoteSave(binding, "unknown"); if (next.kind !== "ready") throw new Error("Expected valid transport intent");
    binding.dispatched(next.submission); binding.settle(next.submission, { kind: "unknown" });
    expect(binding.getSnapshot().mode).toBe("unknown"); expect(binding.getSnapshot().canRestore).toBe(false);
  });
  it("late success cannot wipe a separately discarded and replaced generation", () => {
    const { binding, baseline, clean } = openQuote(); binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "Submitted" } }));
    const prepared = prepareQuoteSave(binding, "late"); if (prepared.kind !== "ready") throw new Error("Expected submission"); binding.dispatched(prepared.submission);
    binding.discard(binding.getSnapshot().current!.stamp); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "Independent new draft" } }));
    binding.settle(prepared.submission, { kind: "persisted", response: detail() });
    expect(binding.getSnapshot().current?.data.header.rfqNumber).toBe("Independent new draft");
  });
  it("intentional subtree removal drops exactly its own unadded breaks", () => {
    const baseline = quoteBaselineFrom(detail(), catalogs); let draft = quoteDraftFrom(baseline);
    draft = addQuoteLine(draft); draft = addQuotePrice(draft, "new-1", "step-a", "HT");
    draft = { ...draft, breakDrafts: { "price-a": { threshold: "old", price: "bad" }, "new-2": { threshold: "new", price: "raw" } } };
    expect(removeQuotePrice(draft, "line-a", "price-a").breakDrafts).toEqual({ "new-2": { threshold: "new", price: "raw" } });
    expect(removeQuoteLine(draft, "new-1").breakDrafts).toEqual({ "price-a": { threshold: "old", price: "bad" } });
    expect(draft.breakDrafts["price-a"].threshold).toBe("old");
  });
  it("uses readable previews without internal row or picker identifiers", () => {
    const baseline = quoteBaselineFrom(detail(), catalogs); const data = quoteDraftFrom(baseline);
    const preview = quoteRecoveryAdapter.preview({ ...data, breakDrafts: { "price-a": { threshold: "", price: "bad" } } }, baseline);
    expect(preview).toContainEqual({ label: "RFQ number", value: "Saved RFQ" });
    expect(preview.some(p => p.value === "bad" && p.label.includes("Unadded"))).toBe(true);
    const text = preview.map(p => p.label + ": " + p.value).join("\n");
    for (const id of ["quote-a", "line-a", "price-a", "break-a", "contact-a", "user-a", "statement-a", "step-a"]) expect(text).not.toContain(id);
    expect(text).toContain("Pat Example"); expect(text).toContain("Quinn Example");
  });
  it("existing break intersection preserves invalid raw values for surviving native rows", () => {
    const lines = lineFormsFrom(detail()); const drafts = { "price-a": { threshold: "", price: "bad" }, "removed": { threshold: "99", price: "1" } };
    expect(retainBreakDrafts(drafts, priceKeysOf(lines))).toEqual({ "price-a": { threshold: "", price: "bad" } });
  });
});

describe("quote native-adoption contract proposal", () => {
  it("Close and CLOSED→Reopen retain surviving unadded text without an ordinary-read override", () => {
    const { binding } = openQuote(); binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: "", price: "bad" } }, seq: 9 }));
    const closeRead = binding.beginNativeRead(); expect(closeRead).not.toBeNull();
    const closed = detail(); closed.status = "CLOSED";
    const closedBase = quoteBaselineFrom(closed, catalogs);
    expect(binding.acceptRead({ kind: "authorized", readId: closeRead!, baseline: closedBase, editable: false }, quoteDraftFrom(closedBase))).toBe(true);
    expect(binding.getSnapshot().reference?.data.breakDrafts["price-a"]).toEqual({ threshold: "", price: "bad" });
    const reopenRead = binding.beginNativeRead(); expect(reopenRead).not.toBeNull();
    const reopenedBase = quoteBaselineFrom(detail(), catalogs);
    expect(binding.acceptRead({ kind: "authorized", readId: reopenRead!, baseline: reopenedBase, editable: true }, quoteDraftFrom(reopenedBase))).toBe(true);
    expect(binding.getSnapshot().mode).toBe("editing");
    expect(binding.getSnapshot().current?.data.breakDrafts["price-a"]).toEqual({ threshold: "", price: "bad" });
    expect(binding.getSnapshot().current?.data.seq).toBe(9);
  });
  it("ordinary changed-status recovery preserves its stale copy instead of native adoption", () => {
    const { binding, detach } = openQuote(); binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: "", price: "bad" } } }));
    detach(); binding.attach("return"); const readId = binding.beginRead(); const changed = detail(); changed.status = "CLOSED";
    const baseline = quoteBaselineFrom(changed, catalogs); binding.acceptRead({ kind: "authorized", readId, baseline, editable: false }, quoteDraftFrom(baseline));
    expect(binding.getSnapshot().reference?.baseline.status).toBe("OPEN"); expect(binding.getSnapshot().canRestore).toBe(false);
    expect(binding.beginNativeRead()).toBeNull(); // Returning unresolved copy must be resolved first.
  });
  for (const boundary of ["detached", "discarded", "same-user-check", "owner-replaced", "new-view"] as const) it(`rejects native adoption after ${boundary}`, () => {
    const { binding, store, detach, baseline, clean } = openQuote();
    binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: "", price: "raw" } } }));
    const nativeRead = binding.beginNativeRead(); expect(nativeRead).not.toBeNull();
    if (boundary === "detached") detach();
    if (boundary === "new-view") { detach(); binding.attach("replacement-view"); }
    if (boundary === "same-user-check") store.acceptIdentity(store.beginIdentityCheck(), "u1");
    if (boundary === "owner-replaced") { store.resetIdentity(); store.acceptIdentity(store.beginIdentityCheck(), "u2"); }
    if (boundary === "discarded") {
      binding.discard(binding.getSnapshot().current!.stamp); const fresh = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId: fresh, baseline, editable: true }, clean);
      binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "New independent work" } }));
    }
    const response = detail(); response.rfqNumber = "Stale native response"; const fresh = quoteBaselineFrom(response, catalogs);
    expect(binding.acceptRead({ kind: "authorized", readId: nativeRead!, baseline: fresh, editable: true }, quoteDraftFrom(fresh))).toBe(false);
    if (boundary === "discarded") expect(binding.getSnapshot().current?.data.header.rfqNumber).toBe("New independent work");
  });
  it("native admission refuses header/tree drafts and queued, pending, unknown, or reference copies", () => {
    for (const blocked of ["header", "queued", "pending", "unknown", "reference"] as const) {
      const { binding, baseline, clean, detach } = openQuote();
      if (blocked === "reference") {
        binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: "2", price: "bad" } } }));
        detach(); binding.attach("return"); const readId = binding.beginRead(); const changed = detail(); changed.rfqNumber = "Server changed";
        const fresh = quoteBaselineFrom(changed, catalogs); binding.acceptRead({ kind: "authorized", readId, baseline: fresh, editable: true }, quoteDraftFrom(fresh));
        binding.startFresh(readId, quoteDraftFrom(fresh));
      } else {
        binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "Changed" } }));
        if (blocked !== "header") {
          const prepared = prepareQuoteSave(binding, blocked); if (prepared.kind !== "ready") throw new Error("Expected submission");
          if (blocked !== "queued") binding.dispatched(prepared.submission);
          if (blocked === "unknown") binding.settle(prepared.submission, { kind: "unknown" });
          if (blocked === "queued" || blocked === "pending") binding.change(d => ({ ...d, header: clean.header }));
        }
      }
      expect(binding.beginNativeRead()).toBeNull();
      void baseline;
    }
  });
  it("a native ticket applies wholesale adoption to intervening same-generation header changes", () => {
    const { binding } = openQuote(); const readId = binding.beginNativeRead(); expect(readId).not.toBeNull();
    binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "Typed while native action runs" }, breakDrafts: { "price-a": { threshold: "", price: "bad" } } }));
    const response = detail(); response.rfqNumber = "Native response"; const baseline = quoteBaselineFrom(response, catalogs);
    expect(binding.acceptRead({ kind: "authorized", readId: readId!, baseline, editable: true }, quoteDraftFrom(baseline))).toBe(true);
    expect(binding.getSnapshot().current?.data.header.rfqNumber).toBe("Native response");
    expect(binding.getSnapshot().current?.data.breakDrafts["price-a"]).toEqual({ threshold: "", price: "bad" });
  });
});


function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
describe("quote production callback seams", () => {
  for (const state of ["invalid", "empty"] as const) it(`Save callback refuses ${state} without capture or transport`, async () => {
    const { binding } = openQuote();
    if (state === "invalid") binding.change(d => ({ ...d, header: { ...d.header, quoteDate: "" } }));
    else binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: "", price: "bad" } } }));
    const capture = vi.spyOn(binding, "capture"); const write = vi.fn(async () => detail());
    const result = await runQuoteSave({ binding, requestId: "refused", write, rejected: () => true, persisted: () => {} });
    expect(result.kind).toBe(state); expect(capture).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it("records raw PATCH persistence before a throwing history/UI callback", async () => {
    const { binding, store } = openQuote(); binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "submitted" } }));
    const write = deferred<QuoteDetailData>(); const response = detail(); response.rfqNumber = "submitted";
    const persisted = vi.fn(() => {
      expect(binding.getSnapshot().current?.data.header.rfqNumber).toBe("submitted");
      expect(store.getSnapshot().count).toBe(0); throw new Error("history callback failed");
    });
    const result = runQuoteSave({ binding, requestId: "save", write: () => write.promise, rejected: () => true, persisted });
    binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "later edit consumed" } })); write.resolve(response);
    await expect(result).rejects.toThrow("history callback failed"); expect(persisted).toHaveBeenCalledTimes(1);
    expect(binding.getSnapshot().mode).not.toBe("unknown"); expect(store.getSnapshot().count).toBe(0);
  });
  for (const outcome of ["detached", "discarded"] as const) it(`records late Save success safely after ${outcome}`, async () => {
    const { binding, store, detach, baseline, clean } = openQuote(); binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "submitted" } }));
    const response = detail(); response.rfqNumber = "submitted"; const write = deferred<QuoteDetailData>();
    const result = runQuoteSave({ binding, requestId: "save", write: () => write.promise, rejected: () => true, persisted: () => {} });
    if (outcome === "detached") detach();
    else { binding.discard(binding.getSnapshot().current!.stamp); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean); binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "replacement" } })); }
    write.resolve(response); expect((await result).kind).toBe("persisted");
    if (outcome === "detached") expect(store.getSnapshot().count).toBe(0);
    else expect(binding.getSnapshot().current?.data.header.rfqNumber).toBe("replacement");
  });
  for (const action of ["close", "reopen", "attach"] as const) it(`native ${action} callback adopts only its original ticket and preserves surviving breaks`, async () => {
    const { binding } = openQuote();
    if (action === "reopen") { const closed = detail(); closed.status = "CLOSED"; const baseline = quoteBaselineFrom(closed, catalogs); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: false }, quoteDraftFrom(baseline)); }
    else binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: " 100 ", price: "raw" } } }));
    const response = detail(); if (action === "close") response.status = "CLOSED"; if (action === "attach") response.lines[0].partId = "part-a";
    const transport = deferred<QuoteDetailData>(); const accepted = vi.fn(); const acknowledged = vi.fn();
    const result = runQuoteNative({ binding, write: () => transport.promise, detail: d => d, catalogs: async () => catalogs, authorized: () => true, acknowledged, accepted });
    transport.resolve(response); expect((await result).kind).toBe("accepted"); expect(acknowledged).toHaveBeenCalledTimes(1); expect(accepted).toHaveBeenCalledTimes(1);
    if (action !== "reopen") expect((binding.getSnapshot().current ?? binding.getSnapshot().reference)?.data.breakDrafts["price-a"]).toEqual({ threshold: " 100 ", price: "raw" });
  });
  it("native UI failure never enters refusal rollback", async () => {
    const { binding } = openQuote(); const rollback = vi.fn(async () => detail());
    const result = runQuoteNative({ binding, write: async () => detail(), detail: d => d, catalogs: async () => catalogs, authorized: () => true,
      acknowledged: () => {}, accepted: () => { throw new Error("UI failed"); }, rollback });
    await expect(result).rejects.toThrow("UI failed"); expect(rollback).not.toHaveBeenCalled();
  });
  it("a failed native action rollback cannot revive a discarded generation with a newly minted read", async () => {
    const { binding } = openQuote(); binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: "old", price: "raw" } } }));
    const rollbackRead = deferred<QuoteDetailData>(); const rollbackStarted = deferred<void>(); const rolledBack = vi.fn();
    const result = runQuoteNative({ binding, write: async () => { throw new Error("action refused"); }, detail: (d: QuoteDetailData) => d,
      catalogs: async () => catalogs, authorized: () => true, acknowledged: () => {}, accepted: () => {},
      rollback: () => { rollbackStarted.resolve(); return rollbackRead.promise; }, rolledBack });
    await rollbackStarted.promise; binding.discard(binding.getSnapshot().current!.stamp); binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "new generation" } }));
    const response = detail(); response.rfqNumber = "rollback server"; rollbackRead.resolve(response);
    expect((await result).kind).toBe("stale"); expect(rolledBack).not.toHaveBeenCalled();
    expect(binding.getSnapshot().current?.data.header.rfqNumber).toBe("new generation");
  });
  it("detached native response never invokes accepted UI or prunes the retained copy", async () => {
    const { binding, detach } = openQuote(); binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: "old", price: "raw" } } }));
    const transport = deferred<QuoteDetailData>(); const accepted = vi.fn();
    const result = runQuoteNative({ binding, write: () => transport.promise, detail: d => d, catalogs: async () => catalogs, authorized: () => true, acknowledged: () => {}, accepted });
    detach(); const response = detail(); response.lines[0].prices = []; transport.resolve(response);
    expect((await result).kind).toBe("stale"); expect(accepted).not.toHaveBeenCalled();
    expect(binding.getSnapshot().current?.data.breakDrafts["price-a"]).toEqual({ threshold: "old", price: "raw" });
  });
  it("delete refusal keeps exact data; acknowledged deletion retires captured generation after later edit", async () => {
    const f = openQuote(); f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "keep on refusal" } }));
    const original = f.binding.getSnapshot().current!; const deleted = vi.fn();
    await expect(deleteThroughCurrentHelper(f, async () => { throw new Error("linked order refusal"); }, deleted)).rejects.toThrow("linked order refusal");
    expect(f.binding.getSnapshot().current).toBe(original); expect(deleted).not.toHaveBeenCalled();
    const remove = deferred<void>(); const result = deleteThroughCurrentHelper(f, () => remove.promise, deleted);
    f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "later same-generation text" } }));
    expect(f.binding.getSnapshot().current!.stamp.generation).toBe(original.stamp.generation);
    remove.resolve(); await result;
    expect(f.store.getSnapshot().count).toBe(0); expect(f.binding.getSnapshot().current).toBeUndefined(); expect(deleted).toHaveBeenCalledTimes(1);
  });
});


// Same real-source callback convention as remaining-bulk-callbacks.test.ts.
function actualQuoteCallback<T>(name: string, environment: Record<string, unknown>): T {
  const path = new URL("../src/app/quotes/[id]/QuoteDetail.tsx", import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.FunctionDeclaration | ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer
      && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === "useCallback") found = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source); if (!found) throw new Error(`Missing actual quote callback ${name}`);
  const code = ts.transpileModule(`return (${found.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T;
}
describe("actual QuoteDetail callbacks", () => {
  for (const scenario of ["empty", "invalid", "persisted-followup-failure"] as const) it(`actual save uses recovery seam for ${scenario}`, async () => {
    const { binding, store } = openQuote();
    if (scenario !== "empty") binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "submitted", ...(scenario === "invalid" ? { quoteDate: "" } : {}) } }));
    const response = { ...detail(), rfqNumber: "submitted", warnings: [] }; const api = vi.fn(async () => response); const setError = vi.fn();
    const history = vi.fn(() => { expect(store.getSnapshot().count).toBe(0); });
    const save = actualQuoteCallback<() => Promise<void>>("save", {
      binding, detail: detail(), header: binding.getSnapshot().current!.data.header, saving: false, editGate: { disabled: false },
      getBrowserDraftSession: () => ({ readAuthorizationTicket: () => ({}), isReadAuthorized: () => true }), mounted: { current: true },
      setSaving: vi.fn(), runQuoteSave, newId: () => "actual-save", api, id: "quote-a", ApiError,
      invalidateHistory: history, setOverlapWarnings: vi.fn(), setError, load: async () => { throw new Error("follow-up read failed"); },
    });
    await save();
    if (scenario === "persisted-followup-failure") { expect(api).toHaveBeenCalledTimes(1); expect(history).toHaveBeenCalledTimes(1); expect(setError).toHaveBeenCalledWith("follow-up read failed"); expect(store.getSnapshot().count).toBe(0); }
    else { expect(api).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled(); }
  });
  it("actual delete blocker GET never adopts or erases the current quote", async () => {
    const { binding, store } = openQuote(); binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "keep this input" } }));
    const before = binding.getSnapshot().current; const blocker = { entityLabel: "Order", name: "#201", id: "order-a", href: "/orders/order-a" };
    const api = vi.fn(async (_url: string, options?: { method: string }) => { if (options?.method === "DELETE") throw new ApiError("Orders still price from it", 400); return detail(); });
    const setBlocked = vi.fn();
    const remove = actualQuoteCallback<() => Promise<void>>("deleteQuote", {
      detail: detail(), deleteGate: { disabled: false }, askReason: async () => "Approved reason", store, binding,
      getBrowserDraftSession: () => ({ readAuthorizationTicket: () => ({}), isReadAuthorized: () => true }), mounted: { current: true },
      runQuoteDelete, api, id: "quote-a", ApiError, router: { push: vi.fn() }, blockersFrom: () => [blocker], setBlocked, setError: vi.fn(),
    });
    await remove(); expect(api).toHaveBeenCalledTimes(2); expect(binding.getSnapshot().current).toBe(before); expect(setBlocked).toHaveBeenCalledWith({ list: [blocker] });
  });
  for (const action of ["closeQuote", "reopenQuote", "attachPart"] as const) it(`actual ${action} invokes the captured native seam`, async () => {
    const { binding } = openQuote(); binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: "", price: "raw" } } }));
    const response = { ...detail(), warnings: [] }; if (action === "closeQuote") response.status = "CLOSED";
    const api = vi.fn(async () => action === "closeQuote" ? { quote: response, linkedOpenOrders: [] } : response);
    const env = { binding, detail: detail(), id: "quote-a", mounted: { current: true },
      getBrowserDraftSession: () => ({ readAuthorizationTicket: () => ({}), isReadAuthorized: () => true }),
      runQuoteNative, checkIdentity: async () => catalogs.permissions, readCatalogs: async () => catalogs, invalidateHistory: vi.fn(), showAccepted: vi.fn(), readIdRef: { current: 0 }, api,
    };
    const nativeAction = actualQuoteCallback<(write: () => Promise<unknown>, select: (response: unknown) => QuoteDetailData, show: (response: unknown) => void) => Promise<void>>("nativeAction", env);
    const actionCallback = actualQuoteCallback<(line?: unknown) => Promise<void>>(action, { ...env, nativeAction, askReason: async () => "Reason", closeGate: { disabled: false }, reopenGate: { disabled: false },
      setError: vi.fn(), setCloseWarning: vi.fn(), setOverlapWarnings: vi.fn(), setAttachPicks: vi.fn(), attachPicks: { "line-a": "part-a" }, editGate: { disabled: false }, dirty: false, recoveryBlocked: false, attachHold: oneShotHold(),
    });
    await actionCallback({ id: "line-a", key: "line-a" }); expect(api).toHaveBeenCalledTimes(1); expect(env.showAccepted).toHaveBeenCalledTimes(1);
    expect((binding.getSnapshot().current ?? binding.getSnapshot().reference)?.data.breakDrafts["price-a"]).toEqual({ threshold: "", price: "raw" });
  });
});


describe("fresh quote read authorization race", () => {
  it("ordinary QuoteDetail load hides a GET200 when fresh me has lost quotes.view", async () => {
    const { binding, store } = openQuote(); binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "retained private" } }));
    const session = { store, readAuthorizationTicket: () => ({}), isReadAuthorized: () => true };
    const seen: string[] = [];
    const api = async (path: string) => {
      seen.push(path);
      if (path === "/api/quotes/quote-a") return detail();
      if (path === "/api/auth/me") return { id: "u1", permissions: ["quotes.edit"] };
      return [];
    };
    const checkIdentity = actualQuoteCallback<() => Promise<readonly string[]>>("checkIdentity", { api, getBrowserDraftSession: () => session });
    const readCatalogs = actualQuoteCallback<(customerId: string, permissions: readonly string[]) => Promise<QuoteRecoveryCatalogs>>("readCatalogs", { api });
    const showAccepted = vi.fn(); const setError = vi.fn();
    const load = actualQuoteCallback<() => Promise<void>>("load", { binding, api, id: "quote-a", mounted: { current: true },
      getBrowserDraftSession: () => session, checkIdentity, readCatalogs, quoteBaselineFrom, quoteDraftFrom, showAccepted, setError, readIdRef: { current: 0 },
    });
    let failure: unknown; try { await load(); } catch (error) { failure = error; }
    expect((failure as Error | undefined)?.message).toBe("Requires quotes.view");
    expect(seen).toEqual(["/api/quotes/quote-a", "/api/auth/me"]);
    expect(showAccepted).not.toHaveBeenCalled(); expect(binding.getSnapshot().mode).toBe("unavailable");
    expect(binding.getSnapshot().savedBaseline).toBeUndefined(); expect(binding.getSnapshot().current).toBeUndefined();
    expect(binding.getSnapshot().reference).toBeUndefined(); expect(store.getSnapshot().count).toBe(1);
  });
  it("native success acknowledges its mutation but hides values when fresh catalogs lack quotes.view", async () => {
    const { binding, store } = openQuote(); binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: "private", price: "raw" } } }));
    const acknowledged = vi.fn(); const accepted = vi.fn();
    const result = await runQuoteNative({ binding, write: async () => detail(), detail: d => d,
      catalogs: async () => ({ ...catalogs, permissions: ["quotes.edit"] }), authorized: () => true, acknowledged, accepted });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect((result.error as Error).message).toBe("Requires quotes.view");
    expect(acknowledged).toHaveBeenCalledTimes(1); expect(accepted).not.toHaveBeenCalled();
    expect(binding.getSnapshot().mode).toBe("unavailable"); expect(binding.getSnapshot().savedBaseline).toBeUndefined();
    expect(binding.getSnapshot().current).toBeUndefined(); expect(binding.getSnapshot().reference).toBeUndefined(); expect(store.getSnapshot().count).toBe(1);
  });
  it("native refusal rollback also hides values if fresh permission no longer permits reading the quote", async () => {
    const { binding } = openQuote(); binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: "private", price: "raw" } } }));
    const rolledBack = vi.fn(); const acknowledged = vi.fn();
    const result = await runQuoteNative({ binding, write: async () => { throw new Error("close refused"); }, detail: (d: QuoteDetailData) => d,
      catalogs: async () => ({ ...catalogs, permissions: ["quotes.edit"] }), authorized: () => true, acknowledged, accepted: vi.fn(), rollback: async () => detail(), rolledBack });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect((result.error as Error).message).toBe("Requires quotes.view");
    expect(acknowledged).not.toHaveBeenCalled(); expect(rolledBack).not.toHaveBeenCalled();
    expect(binding.getSnapshot().mode).toBe("unavailable"); expect(binding.getSnapshot().savedBaseline).toBeUndefined();
    expect(binding.getSnapshot().current).toBeUndefined(); expect(binding.getSnapshot().reference).toBeUndefined();
  });
});


describe("raw quote retention independent of normalized Save", () => {
  for (const field of ["eachWeight", "setupCharge", "unitPrice", "minimumCharge"] as const) it(`retains exactly two raw spaces in null-baseline ${field} through Restore and exact Discard`, () => {
    const h = openQuote(); const { binding, store, detach } = h; const source = detail();
    if (field === "eachWeight") source.lines[0].eachWeight = null; else source.lines[0].prices[0][field] = null;
    const baseline = quoteBaselineFrom(source, catalogs); const clean = quoteDraftFrom(baseline);
    binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline, editable: true }, clean);
    binding.change(d => ({ ...d, lines: d.lines.map(l => field === "eachWeight" ? { ...l, eachWeight: "  " } : { ...l, prices: l.prices.map(p => ({ ...p, [field]: "  " })) }) }));
    const current = binding.getSnapshot().current!;
    expect(quoteSaveDirty(current.data, current.baseline)).toBe(false); expect(prepareQuoteSave(binding, "raw-only")).toEqual({ kind: "empty" });
    expect(store.getSnapshot().count).toBe(1); expect(store.getSnapshot().rows).toHaveLength(1); expect(store.getSnapshot().rows[0].pending).toBe(false);
    detach(); binding.attach("return-raw"); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    const view = binding.getSnapshot(); expect(view.mode).toBe("offer"); expect(binding.restore(view.current!.stamp, readId)).toBe(true);
    const recovered = binding.getSnapshot().current!; expect(recovered.data.lines.map(l => l.key)).toEqual(["line-a"]);
    expect(recovered.data.lines[0].prices.map(p => p.key)).toEqual(["price-a"]);
    expect(field === "eachWeight" ? recovered.data.lines[0].eachWeight : recovered.data.lines[0].prices[0][field]).toBe("  ");
    binding.discard({ ...recovered.stamp, version: recovered.stamp.version + 1 }); expect(store.getSnapshot().count).toBe(1);
    binding.discard(recovered.stamp); expect(store.getSnapshot().count).toBe(0);
    const discarded = binding.getSnapshot().current!.data;
    expect(field === "eachWeight" ? discarded.lines[0].eachWeight : discarded.lines[0].prices[0][field]).toBe("");
  });
  it("ignores allocator and display-only edits and retains existing whitespace-only unadded-break semantics", () => {
    const { binding, store } = openQuote();
    binding.change(d => ({ ...d, seq: 40, lines: d.lines.map(l => ({ ...l, linkedOrders: l.linkedOrders.map(o => ({ ...o, orderNumber: 999 })),
      prices: l.prices.map(p => ({ ...p, stepCode: "Display rename", stepName: "Display only" })) })), breakDrafts: { "price-a": { threshold: "  ", price: "  " } } }));
    expect(store.getSnapshot().count).toBe(0); expect(prepareQuoteSave(binding, "display-only")).toEqual({ kind: "empty" });
  });
  it("raw-only input does not change native admission or successful wholesale adoption", () => {
    const observed = vi.spyOn(quoteRecoveryAdapter, "canBeginNativeRead");
    try {
      const { binding, store } = openQuote(); binding.change(d => ({ ...d, lines: d.lines.map(l => ({ ...l, prices: l.prices.map(p => ({ ...p, minimumCharge: "  " })) })) }));
      const native = binding.beginNativeRead(); expect(native).not.toBeNull();
      const response = detail(); response.status = "CLOSED"; const baseline = quoteBaselineFrom(response, catalogs);
      expect(binding.acceptRead({ kind: "authorized", readId: native!, baseline, editable: false }, quoteDraftFrom(baseline))).toBe(true);
      const after = binding.getSnapshot(); expect(after.savedBaseline?.status).toBe("CLOSED");
      expect(after.current).toBeUndefined(); expect(after.reference).toBeUndefined(); expect(store.getSnapshot().count).toBe(0);
      // The next admission sees the result of the FIRST wholesale adoption; no
      // second response or fresh read can normalize the raw value for this assertion.
      observed.mockClear(); expect(binding.beginNativeRead()).not.toBeNull(); expect(observed).toHaveBeenCalledTimes(1);
      expect(observed.mock.calls[0][0].baseline.status).toBe("CLOSED");
      expect(observed.mock.calls[0][0].data.lines[0].prices[0].minimumCharge).toBe("");
    } finally { observed.mockRestore(); }
  });
  it("the actual Discard callback clears raw-only work while the actual button remains reachable", () => {
    const { binding, store } = openQuote(); binding.change(d => ({ ...d, lines: d.lines.map(l => ({ ...l, prices: l.prices.map(p => ({ ...p, minimumCharge: "  " })) })) }));
    const data = binding.getSnapshot().current!;
    const src = ts.createSourceFile("QuoteDetail.tsx", readFileSync(new URL("../src/app/quotes/[id]/QuoteDetail.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let disabled: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(src) === "button") {
        const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
        if (attrs.some(a => a.name.getText(src) === "onClick" && a.initializer?.getText(src) === "{discardChanges}")) {
          const attr = attrs.find(a => a.name.getText(src) === "disabled");
          if (attr?.initializer && ts.isJsxExpression(attr.initializer)) disabled = attr.initializer.expression;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(src); expect(disabled).toBeDefined();
    const expression = ts.transpileModule(`return (${disabled!.getText(src)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const env = { dirty: false, breakDraftStarted: false, recoveryBlocked: false, rawDraftRetained: quoteRecoveryAdapter.dirty(data.data, data.baseline) };
    const isDisabled = new Function(...Object.keys(env), expression)(...Object.values(env)); expect(isDisabled).toBe(false);
    actualQuoteCallback<() => void>("discardChanges", { binding, setError: vi.fn() })(); expect(store.getSnapshot().count).toBe(0);
    expect(binding.getSnapshot().current?.data.lines[0].prices[0].minimumCharge).toBe("");
  });
});

// Extra retire property is passed via a variable so this tests-first file typechecks against
// the CURRENT store/stamps helper and the proposed retire-only signature without a runtime stub.
function deleteThroughCurrentHelper(f: ReturnType<typeof openQuote>, remove: () => Promise<unknown>, deleted = vi.fn()) {
  const args = { store: f.store, stamps: f.store.stampsForPath("/quotes/quote-a"), retire: f.binding.captureRetirement(), remove, deleted };
  return runQuoteDelete(args);
}
/** The page's `deleteQuote` captures its retirement only once the reason dialog has answered
 *  (`await askReason`, the modal form since PR 3 of the UX redesign; the dialog is modal, so
 *  nothing changes the draft meanwhile). A test that changes the binding "after the click, before
 *  the DELETE lands" waits for that answer first: one macrotask drains the dialog's microtasks. */
const dialogAnswered = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deleteCallback(f: ReturnType<typeof openQuote>, remove: () => Promise<unknown>, overrides: Record<string, unknown> = {}) {
  const push = vi.fn(), setError = vi.fn();
  const callback = actualQuoteCallback<() => Promise<void>>("deleteQuote", {
    detail: detail(), deleteGate: { disabled: false }, askReason: async () => "Approved reason", store: f.store, binding: f.binding,
    getBrowserDraftSession: () => ({ readAuthorizationTicket: () => ({}), isReadAuthorized: () => true }), mounted: { current: true },
    runQuoteDelete, api: remove, id: "quote-a", ApiError, router: { push }, blockersFrom: () => [], setBlocked: vi.fn(), setError,
    ...overrides,
  });
  return { callback, push, setError };
}
describe("quote DELETE generation retirement", () => {
  it("actual callback retires same-generation later text and older reference, preserving another quote", async () => {
    const f = openQuote(); f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "older A" } }));
    const changed = quoteBaselineFrom({ ...detail(), rfqNumber: "server changed" }, catalogs);
    const readId = f.binding.beginRead(); expect(f.binding.acceptRead({ kind: "authorized", readId, baseline: changed, editable: true }, quoteDraftFrom(changed))).toBe(true);
    expect(f.binding.startFresh(readId, quoteDraftFrom(changed))).toBe(true);
    f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "current B" } }));
    const reference = f.binding.getSnapshot().reference!; expect(reference.data.header.rfqNumber).toBe("older A");
    const owner = f.store.getSnapshot().owner!;
    const other = f.store.bind({ owner, record: { kind: "quote", id: "quote-b" }, editor: quoteRecoveryAdapter.kind }, { label: "Other quote", href: "/quotes/quote-b" }, quoteRecoveryAdapter);
    other.attach("other"); const otherBaseline = quoteBaselineFrom({ ...detail(), id: "quote-b" }, catalogs); const otherRead = other.beginRead();
    other.acceptRead({ kind: "authorized", readId: otherRead, baseline: otherBaseline, editable: true }, quoteDraftFrom(otherBaseline));
    other.change(d => ({ ...d, header: { ...d.header, rfqNumber: "sibling untouched" } })); const sibling = other.getSnapshot().current;
    const pending = deferred<void>(); const action = deleteCallback(f, () => pending.promise); const running = action.callback(); await dialogAnswered();
    const generation = f.binding.getSnapshot().current!.stamp.generation;
    f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "later same B" } }));
    expect(f.binding.getSnapshot().current!.stamp.generation).toBe(generation); pending.resolve(); await running;
    expect(f.binding.getSnapshot().current).toBeUndefined(); expect(f.binding.getSnapshot().reference).toBeUndefined();
    expect(other.getSnapshot().current).toBe(sibling); expect(f.store.getSnapshot().count).toBe(1); expect(action.push).toHaveBeenCalledWith("/quotes");
  });
  for (const state of ["checking", "unavailable", "detached"] as const) it(`known delete retires captured generation through same-owner ${state}`, async () => {
    const f = openQuote(); f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "submitted scope" } }));
    const remove = deferred<void>(); const action = deleteCallback(f, () => remove.promise, { mounted: { current: state !== "detached" } }); const running = action.callback(); await dialogAnswered();
    f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "later in captured generation" } }));
    if (state === "checking") f.store.beginIdentityCheck();
    if (state === "unavailable") { const id = f.binding.beginRead(); f.binding.acceptRead({ kind: "unavailable", readId: id }, {} as never); }
    if (state === "detached") f.detach();
    remove.resolve(); await running;
    if (state === "checking") f.store.acceptIdentity(f.store.beginIdentityCheck(), "u1");
    expect(f.store.getSnapshot().count).toBe(0);
    expect(f.binding.getSnapshot().current).toBeUndefined(); expect(f.binding.getSnapshot().reference).toBeUndefined();
  });
  it("explicit Discard and a replacement generation survive the old successful DELETE", async () => {
    const f = openQuote(); f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "old" } }));
    const old = f.binding.getSnapshot().current!.stamp; const pending = deferred<void>(); const action = deleteCallback(f, () => pending.promise); const running = action.callback(); await dialogAnswered();
    f.binding.discard(old); f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "new generation" } })); const replacement = f.binding.getSnapshot().current!;
    expect(replacement.stamp.generation).not.toBe(old.generation); pending.resolve(); await running;
    expect(f.binding.getSnapshot().current).toBe(replacement); expect(f.store.getSnapshot().count).toBe(1);
  });
  it("actual rejected DELETE preserves the exact current and reference snapshots", async () => {
    const f = openQuote(); f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "old reference" } }));
    const changed = quoteBaselineFrom({ ...detail(), rfqNumber: "saved changed" }, catalogs); const id = f.binding.beginRead();
    f.binding.acceptRead({ kind: "authorized", readId: id, baseline: changed, editable: true }, quoteDraftFrom(changed)); f.binding.startFresh(id, quoteDraftFrom(changed));
    f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "keep current" } })); const before = f.binding.getSnapshot();
    const action = deleteCallback(f, async () => { throw new ApiError("Refused deletion", 400); }); await action.callback();
    expect(f.binding.getSnapshot()).toBe(before); expect(action.push).not.toHaveBeenCalled(); expect(action.setError).toHaveBeenCalledWith("Refused deletion");
  });
  it("a DELETE whose 2xx answer could not be read retires the drafts and goes on to the quote list, as a landed one does (#547)", async () => {
    // The owner's answer of 2026-10-18 to the #547 plan's question 4: a 2xx proves the delete
    // committed, so the real store's drafts for this quote are retired and nothing is shown.
    const f = openQuote(); f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "typed before the delete" } }));
    const lost = new UnreadableAnswerError(WRITE_ANSWER_UNREADABLE, { cause: new SyntaxError("Unexpected end of JSON input") });
    const action = deleteCallback(f, () => Promise.reject(lost)); await action.callback();
    expect(f.binding.getSnapshot().current).toBeUndefined(); expect(f.binding.getSnapshot().reference).toBeUndefined();
    expect(f.store.getSnapshot().count).toBe(0); expect(action.push).toHaveBeenCalledWith("/quotes"); expect(action.setError).not.toHaveBeenCalled();
  });
  it("view/delete without edit permission still invokes native deletion", async () => {
    const f = openQuote(); const baseline = quoteBaselineFrom(detail(), { ...catalogs, permissions: ["quotes.view", "quotes.delete"] }); const id = f.binding.beginRead();
    f.binding.acceptRead({ kind: "authorized", readId: id, baseline, editable: false }, quoteDraftFrom(baseline));
    expect(f.binding.getSnapshot().mode).not.toBe("editing"); const remove = vi.fn(async () => {}); const action = deleteCallback(f, remove, { deleteGate: gate(["quotes.view", "quotes.delete"], "quotes.delete") }); await action.callback();
    expect(remove).toHaveBeenCalledTimes(1); expect(action.push).toHaveBeenCalledWith("/quotes");
  });
  for (const state of ["clean", "no-binding", "unavailable-before-capture"] as const) it(`retirement does not add native delete admission guard: ${state}`, async () => {
    const f = openQuote();
    if (state === "unavailable-before-capture") { const id = f.binding.beginRead(); f.binding.acceptRead({ kind: "unavailable", readId: id }, {} as never); expect(f.binding.captureRetirement()).toBeNull(); }
    const remove = vi.fn(async () => {}); const action = deleteCallback(f, remove, state === "no-binding" ? { binding: null } : {}); await action.callback();
    expect(remove).toHaveBeenCalledTimes(1); expect(action.push).toHaveBeenCalledWith("/quotes");
  });
});
