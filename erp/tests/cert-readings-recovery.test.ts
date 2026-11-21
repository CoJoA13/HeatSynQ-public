import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createDraftStore, type Adapter } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import { drainOtherKeys } from "../src/lib/drain-queue";
import { UnreadableAnswerError } from "../src/lib/fetcher";
import { newId } from "../src/lib/client-id";
import { batchedRead } from "../src/lib/batched-read";
import { readFinishedDecimal } from "../src/lib/decimal-entry";
import { computePassed } from "../src/lib/pass-fail";
import { READING_VALUE } from "../src/lib/part-boxes";
import type { CertDetailData } from "../src/app/certs/[id]/CertDetail";
import type { ReadingPayload } from "../src/app/certs/[id]/RequirementBlock";
import {
  certReadingsRecoveryAdapter, certReadingsBaselineFrom, certReadingsDraftFrom,
  editCertReading, addCertReading, removeCertReading, prepareCertReadings, readCertReadings,
  type CertReadingsDraft, type CertReadingsBaseline, type CapturedCertReadings, type CertReadingsReadRequirements,
} from "../src/lib/cert-readings-recovery";

const permissions = ["certs.view", "certs.edit"];
function baseline(id = "req-a"): CertReadingsBaseline {
  return { certId: "cert-a", printedAt: null, deletedAt: null, permissions,
    requirement: { id, orderLineId: "line-a", orderLineIdAtSeed: "line-a", linePosition: 1, partNumber: "P-1", partName: "Bracket",
      position: 1, inspectionCodeId: "inspection-a", inspectionCodeName: "Hardness", scaleId: "scale-a", scaleName: "HRC",
      min: 10, max: 20, sampleQty: "3", location: "Surface",
      readings: [{ id: `reading-${id}`, position: 1, value: 12, passed: true, overridden: false, note: "Saved" }] } };
}
function detail(): CertDetailData {
  return { id: "cert-a", orderId: "order-a", orderNumber: 101, sequence: null, customerCode: "ACME", customerName: "Example", scope: "ORDER",
    loadNumber: null, shipperId: null, shipperNumber: null, printedAt: null, deletedAt: null, freeform: "Saved cert text", internalNotes: "Private",
    poNumber: "PO", material: "Steel", receivedDate: "2026-09-12", requirements: [baseline().requirement, baseline("req-b").requirement] };
}
const clean: CertReadingsDraft = { rows: [{ key: 0, value: "12", overridden: false, passedChoice: "pass", note: "Saved" }], nextKey: 1, dirty: false };
function setup(adapter = certReadingsRecoveryAdapter) {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const open = (id: string) => {
    const binding = store.bind({ owner, record: { kind: "cert", id: "cert-a" }, editor: "cert-readings", childId: id }, { label: "Cert results", href: "/certs/cert-a" }, adapter);
    const detach = binding.attach(id); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: baseline(id), editable: true }, clean);
    return { binding, detach };
  };
  return { store, owner, a: open("req-a"), b: open("req-b") };
}
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function actual<T>(file: "CertDetail" | "RequirementBlock", name: string, env: Record<string, unknown>): T {
  const text = readFileSync(new URL(`../src/app/certs/[id]/${file}.tsx`, import.meta.url), "utf8");
  const source = ts.createSourceFile(`${file}.tsx`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) body = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === "useCallback") body = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source); expect(body, `actual ${name} callback`).toBeDefined();
  const js = ts.transpileModule(`return (${body!.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env)) as T;
}

describe("cert readings domain", () => {
  it("validates retained raw shapes without treating local decimal refusal as malformed", () => {
    expect(certReadingsRecoveryAdapter.valid({ ...clean, rows: [{ ...clean.rows[0], value: " bad ", overridden: true, passedChoice: "" }] }, baseline())).toBe(true);
    for (const malformed of [{ ...clean, nextKey: -1 }, { ...clean, dirty: "yes" }, { ...clean, rows: [{ ...clean.rows[0], passedChoice: "maybe" }] }, { ...clean, rows: [{ ...clean.rows[0], key: 1 }], nextKey: 1 }])
      expect(certReadingsRecoveryAdapter.valid(malformed, baseline())).toBe(false);
    const bad = baseline(); Object.assign(bad.requirement, { inspectionCodeId: undefined });
    expect(certReadingsRecoveryAdapter.valid(clean, bad)).toBe(false);
  });
  it("projects only this requirement's complete frozen identity/readings and cert access", () => {
    const source = detail(); const result = certReadingsBaselineFrom(source, "req-a", permissions);
    expect(result).not.toBeNull(); expect(result).toEqual(baseline());
    source.requirements[0].readings[0].note = "mutated transport";
    source.requirements[1].readings[0].value = 19;
    expect(result!.requirement.readings[0].note).toBe("Saved");
    expect(certReadingsBaselineFrom(source, "missing", permissions)).toBeNull();
  });
  it("seeds server row order, three verdict states and next numeric key", () => {
    const base = baseline(); base.requirement.readings.push({ id: "r2", position: 2, value: null, passed: null, overridden: false, note: "" }, { id: "r3", position: 3, value: 25, passed: false, overridden: true, note: "Override" });
    expect(certReadingsDraftFrom(base)).toEqual({ rows: [
      { key: 0, value: "12", overridden: false, passedChoice: "pass", note: "Saved" },
      { key: 1, value: "", overridden: false, passedChoice: "", note: "" },
      { key: 2, value: "25", overridden: true, passedChoice: "fail", note: "Override" },
    ], nextKey: 3, dirty: false });
  });
  it("synchronous reducers preserve raw last events, edit-back dirty and monotonic keys", () => {
    let data = addCertReading(clean); data = editCertReading(data, 1, { value: "  bad ", overridden: true, passedChoice: "", note: " raw " });
    expect(data.rows).toHaveLength(2); expect(data.rows[1]).toEqual({ key: 1, value: "  bad ", overridden: true, passedChoice: "", note: " raw " });
    data = removeCertReading(data, 1); data = editCertReading(data, 0, { value: "12" });
    expect(data.dirty).toBe(true); expect(data.nextKey).toBe(2); expect(addCertReading(data).rows[1].key).toBe(2); expect(clean.dirty).toBe(false);
  });
  it("retains two independent raw drafts and restores exact allocator/order only after fresh access", () => {
    const { a, b, store } = setup();
    a.binding.change(() => ({ rows: [{ key: 7, value: "", overridden: true, passedChoice: "fail", note: " raw " }, { key: 3, value: "bad", overridden: false, passedChoice: "", note: "" }], nextKey: 8, dirty: true }));
    b.binding.change(d => ({ ...d, dirty: true, rows: d.rows.map(r => ({ ...r, note: "keep sibling note" })) }));
    expect(store.getSnapshot().count).toBe(2); const old = a.binding.getSnapshot().current!.stamp;
    a.detach(); a.binding.attach("returned");
    expect(a.binding.getSnapshot().current).toBeUndefined(); expect(a.binding.restore(old, 1)).toBe(false);
    const readId = a.binding.beginRead(); a.binding.acceptRead({ kind: "authorized", readId, baseline: baseline(), editable: true }, clean);
    expect(a.binding.getSnapshot().mode).toBe("offer"); expect(a.binding.restore(old, readId)).toBe(true);
    expect(a.binding.getSnapshot().current!.data).toEqual({ rows: [{ key: 7, value: "", overridden: true, passedChoice: "fail", note: " raw " }, { key: 3, value: "bad", overridden: false, passedChoice: "", note: "" }], nextKey: 8, dirty: true });
    expect(b.binding.getSnapshot().current!.data.rows[0].note).toBe("keep sibling note");
  });
  for (const change of ["reading-id", "reading-order", "reading-value", "reading-verdict", "frozen-id", "frozen-value", "printed", "voided", "grants"] as const) it(`conflicts on changed ${change}`, () => {
    const saved = baseline(); const fresh = baseline();
    if (change === "reading-id") fresh.requirement.readings[0].id = "replacement";
    if (change === "reading-order") fresh.requirement.readings[0].position = 2;
    if (change === "reading-value") fresh.requirement.readings[0].value = 13;
    if (change === "reading-verdict") fresh.requirement.readings[0].passed = false;
    if (change === "frozen-id") Object.assign(fresh.requirement, { inspectionCodeId: "changed" });
    if (change === "frozen-value") Object.assign(fresh.requirement, { min: 11 });
    if (change === "printed") Object.assign(fresh, { printedAt: "2026-09-12T12:00:00Z" });
    if (change === "voided") Object.assign(fresh, { deletedAt: "2026-09-12T12:00:00Z" });
    if (change === "grants") Object.assign(fresh, { permissions: ["certs.view"] });
    expect(certReadingsRecoveryAdapter.baselineEqual(saved, fresh)).toBe(false);
  });
  it("does not conflict on a sibling's changed readings or cert notes", () => {
    const fresh = detail(); fresh.requirements[1].readings[0].note = "sibling committed"; fresh.internalNotes = "blur saved";
    const projected = certReadingsBaselineFrom(fresh, "req-a", permissions); expect(projected).not.toBeNull();
    expect(certReadingsRecoveryAdapter.baselineEqual(baseline(), projected!)).toBe(true);
  });
  for (const kind of ["persisted", "rejected", "unknown"] as const) it(`retires only captured requirement generation after ${kind}`, () => {
    const { a, b } = setup(); a.binding.change(d => ({ ...d, dirty: true })); b.binding.change(d => ({ ...d, dirty: true, rows: d.rows.map(r => ({ ...r, note: "keep sibling note" })) }));
    const sub = a.binding.capture([], "request-a"); expect(a.binding.dispatched(sub)).toBe(true);
    a.binding.settle(sub, kind === "persisted" ? { kind, response: detail() } : { kind });
    expect(a.binding.getSnapshot().current).toBeUndefined(); expect(b.binding.getSnapshot().current!.data.rows[0].note).toBe("keep sibling note");
  });
  it("late outcome after explicit Discard preserves the independently created generation", () => {
    const { a } = setup(); a.binding.change(d => ({ ...d, dirty: true })); const sub = a.binding.capture([], "old"); a.binding.dispatched(sub);
    a.binding.discard(a.binding.getSnapshot().current!.stamp); a.binding.change(d => ({ ...d, dirty: true, rows: d.rows.map(r => ({ ...r, note: "new generation" })) }));
    const newer = a.binding.getSnapshot().current!.stamp; expect(newer.generation).not.toBe(sub.stamp.generation);
    a.binding.settle(sub, { kind: "unknown" }); expect(a.binding.getSnapshot().current!.stamp).toEqual(newer); expect(a.binding.getSnapshot().current!.data.rows[0].note).toBe("new generation");
  });
  for (const patch of [{ value: "bad" }, { note: "x".repeat(501) }, { value: "", overridden: true }, { value: "12", overridden: true, passedChoice: "" as const }]) it(`local refusal retains rows and captures no save: ${Object.keys(patch).join("/")}`, () => {
    const { a } = setup(); a.binding.change(d => ({ ...d, dirty: true, rows: d.rows.map(r => ({ ...r, ...patch })) }));
    const capture = vi.spyOn(a.binding, "capture"); const before = a.binding.getSnapshot().current!.data;
    expect(prepareCertReadings(a.binding, "invalid").kind).toBe("refused"); expect(capture).not.toHaveBeenCalled(); expect(a.binding.getSnapshot().current!.data).toEqual(before);
  });
  it.each([".36", "36.", "0.36000"])("prepareCertReadings sends %j as typed", value => {
    const { a } = setup(); a.binding.change(d => ({ ...d, dirty: true, rows: [{ key: 0, value, overridden: false, passedChoice: "", note: "" }] }));
    const prepared = prepareCertReadings(a.binding, "req-1");
    expect(prepared.kind).toBe("ready");
    if (prepared.kind === "ready") expect(prepared.captured.submission.payload).toEqual([{ value, passed: null, overridden: false, note: "" }]);
  });
  it.each(["1e2", "1234567", "1.00001", ".", "-.5"])("prepareCertReadings refuses %j", value => {
    const { a } = setup(); a.binding.change(d => ({ ...d, dirty: true, rows: [{ key: 0, value, overridden: false, passedChoice: "", note: "" }] }));
    expect(prepareCertReadings(a.binding, "req-1").kind).toBe("refused");
  });
  describe("Save readings names every refused reading", () => {
    const rowsOf = (specs: Partial<{ value: string; overridden: boolean; passedChoice: "" | "pass" | "fail"; note: string }>[]) =>
      specs.map((s, key) => ({ key, value: "", overridden: false, passedChoice: "" as const, note: "", ...s }));
    const run = (specs: Parameters<typeof rowsOf>[0]) => {
      const { a } = setup(); a.binding.change(d => ({ ...d, dirty: true, rows: rowsOf(specs), nextKey: specs.length }));
      const capture = vi.spyOn(a.binding, "capture"); const before = a.binding.getSnapshot().current!.data;
      const result = prepareCertReadings(a.binding, "req-1");
      expect(capture).not.toHaveBeenCalled(); expect(a.binding.getSnapshot().current!.data).toEqual(before);
      return result;
    };
    it("lists every refused reading at once, in row order, and captures nothing", () => {
      expect(run([{ value: "-1" }, { value: "1.23456" }, { value: "45" }])).toEqual({ kind: "refused",
        error: "Reading 1, Value: cannot be negative.\nReading 2, Value: use at most 4 digits after the point." });
    });
    it("lists a refused value before the same row's note", () => {
      expect(run([{ value: "x", note: "n".repeat(501) }])).toEqual({ kind: "refused",
        error: "Reading 1, Value: enter a number without $ or commas, such as 0.36.\nReading 1: the note is over 500 characters." });
    });
    it("keeps the override sentences, in row order beside the decimal ones", () => {
      expect(run([{ value: "", overridden: true }, { value: "12", overridden: true }, { value: "bad" }])).toEqual({ kind: "refused",
        error: ["Reading 1: an override needs a measurement value.",
          "Reading 2: pick Pass or Fail for the override \u2014 an overridden reading cannot stay pending.",
          "Reading 3, Value: enter a number without $ or commas, such as 0.36."].join("\n") });
    });
    it("does not ask for Pass or Fail beside a refused value on an overridden row", () => {
      expect(run([{ value: "-2", overridden: true }])).toEqual({ kind: "refused", error: "Reading 1, Value: cannot be negative." });
    });
    it("the block's red line breaks at each newline", () => {
      const text = readFileSync(new URL("../src/app/certs/[id]/RequirementBlock.tsx", import.meta.url), "utf8");
      // Since commit 1d5e9be9 the line is `NOTICE.refusal` in a braced template, the pre-line token beside it.
      expect(text).toMatch(/<p className=\{`\$\{NOTICE\.refusal\}[^`]*whitespace-pre-line[^`]*`\}>\{localError\}<\/p>/);
    });
    it("the access refusal still wins alone", () => {
      const { a } = setup(); a.binding.change(d => ({ ...d, dirty: true, rows: rowsOf([{ value: "-1" }]) }));
      a.binding.beginRead();
      expect(a.binding.getSnapshot().mode).not.toBe("editing");
      expect(prepareCertReadings(a.binding, "req-1")).toEqual({ kind: "refused", error: "Confirm access and resolve retained readings before saving." });
    });
  });
  it("valid save captures only normalized payload and leaves raw rows untouched until dispatch", () => {
    const { a } = setup(); a.binding.change(d => ({ ...d, dirty: true, rows: [{ key: 0, value: " 12.50 ", overridden: true, passedChoice: "fail", note: " raw " }] }));
    const result = prepareCertReadings(a.binding, "valid"); expect(result.kind).toBe("ready"); if (result.kind !== "ready") return;
    expect(result.captured.submission.payload).toEqual([{ value: "12.50", passed: false, overridden: true, note: " raw " }]);
    expect(result.captured.submission.submitted.data.rows[0].value).toBe(" 12.50 ");
  });
});

// Literal test adapter isolates the parent callback contract from the not-yet-implemented
// domain adapter. This test's behavior depends on calling dispatched/settle at the raw seam.
const retiring: Adapter<CertReadingsDraft, CertReadingsBaseline, ReadingPayload[], CertDetailData, never, CertReadingsReadRequirements> = {
  readRequirements: () => ({}),
  kind: "cert-readings", schema: "literal-callback-domain", valid: () => true, dirty: d => d.dirty, baselineEqual: () => true,
  reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }), settle: () => ({ kind: "retire" }), preview: () => [],
};
function parentHarness(options: { accept?: boolean; rollbackFails?: boolean; rollback?: Promise<CertDetailData>; apply?: () => void; adapter?: typeof certReadingsRecoveryAdapter } = {}) {
  const h = setup(options.adapter ?? retiring); const queue = { current: new Map<string, Promise<unknown>>() }; const inFlight = { current: new Map<string, Promise<unknown>>() };
  const serial = actual<(key: string, fn: () => Promise<void>) => Promise<void>>("CertDetail", "serial", { queue });
  const setCert = vi.fn(() => { options.apply?.(); }); const setError = vi.fn(); const bumpReset = vi.fn(); const invalidateHistory = vi.fn();
  const applyMutation = actual<(run: () => Promise<CertDetailData>) => Promise<void>>("CertDetail", "applyMutation", { mutations: { next: () => 1, accept: () => options.accept ?? true }, setCert, editGuard: { applyPayload: (d: CertDetailData) => d }, UnreadableAnswerError, invalidateHistory, writes: { dispatched: () => {} } });
  const requests: ReturnType<typeof deferred<CertDetailData>>[] = [];
  const api = vi.fn(() => { const req = deferred<CertDetailData>(); requests.push(req); return req.promise; });
  const load = vi.fn(async () => { if (options.rollbackFails) throw new Error("rollback GET failed"); return options.rollback ?? detail(); });
  const save = actual<(id: string, readings: ReadingPayload[], captured: CapturedCertReadings) => Promise<void>>("CertDetail", "saveReadings", { id: "cert-a", serial, applyMutation, api, inFlight, invalidateHistory, setError, bumpReset, drainOtherKeys, load });
  const capture = (which: "a" | "b", requestId: string) => {
    const binding = h[which].binding; binding.change(d => ({ ...d, dirty: true, rows: d.rows.map(r => ({ ...r, note: which === "b" ? "keep sibling note" : "attempt" })) }));
    const submission = binding.capture([{ value: "12", passed: null, overridden: false, note: "attempt" }], requestId); return { binding, submission };
  };
  return { ...h, save, capture, requests, api, inFlight, queue, load, setCert, setError, bumpReset, invalidateHistory };
}

describe("actual CertDetail queued readings callbacks", () => {
  it("settles persisted exactly once before actual presentation throws, never downgrading the raw acknowledgement", async () => {
    const observations: string[] = [];
    const h = parentHarness({ apply: () => { observations.push("UI"); throw new Error("UI callback failed"); } });
    const c = h.capture("a", "raw-success"); const original = c.binding.settle;
    const settle = vi.spyOn(c.binding, "settle").mockImplementation((submission, outcome) => { observations.push(outcome.kind); original(submission, outcome); });
    const pending = h.save("req-a", c.submission.payload, c); await flush(); h.requests[0].resolve(detail()); await pending;
    expect(observations).toEqual(["persisted", "UI"]); expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0]).toBe(c.submission); expect(settle.mock.calls[0][1]).toEqual({ kind: "persisted", response: detail() });
    expect(h.a.binding.getSnapshot().current).toBeUndefined();
  });
  it("acknowledges raw persistence before a stale mutation ticket can drop presentation", async () => {
    const h = parentHarness({ accept: false }); const c = h.capture("a", "save-a"); const pending = h.save("req-a", c.submission.payload, c); await flush();
    expect(h.requests).toHaveLength(1); expect(h.api).toHaveBeenCalledWith("/api/certs/cert-a/results", { method: "PUT", body: JSON.stringify({ requirements: [{ id: "req-a", readings: c.submission.payload }] }) });
    h.requests[0].resolve(detail()); await pending;
    expect(h.a.binding.getSnapshot().current).toBeUndefined(); expect(h.setCert).not.toHaveBeenCalled();
  });
  for (const error of [Object.assign(new Error("refused"), { status: 400 }), new Error("network unknown")]) it(`retires dispatched ${error.message} even when rollback GET fails`, async () => {
    const h = parentHarness({ rollbackFails: true }); const c = h.capture("a", "save-a"); h.b.binding.change(d => ({ ...d, dirty: true, rows: d.rows.map(r => ({ ...r, note: "keep sibling note" })) }));
    const pending = h.save("req-a", c.submission.payload, c); await flush(); h.requests[0].reject(error); await pending;
    expect(h.a.binding.getSnapshot().current).toBeUndefined(); expect(h.b.binding.getSnapshot().current!.data.rows[0].note).toBe("keep sibling note"); expect(h.load).toHaveBeenCalledOnce(); expect(h.setError).toHaveBeenCalledWith(error.message);
  });
  it("an answer that could not be read settles unknown, History is told once by the seam, the rollback read runs once, and the error line shows the sentence (#547)", async () => {
    // The seam and `saveReadings` are handed the same `invalidateHistory`, so "once" counts both: the
    // seam tells for this error kind, and the caller tells only after a save that landed. The block's
    // check reads a `status` from 400 to 499 as a refusal; this error has no such status, so the
    // save settles unknown, not rejected.
    const h = parentHarness(); const c = h.capture("a", "save-a"); const settle = vi.spyOn(c.binding, "settle");
    const lost = new UnreadableAnswerError("The change was saved, but the answer could not be read. Reload the page to see it.", { cause: new SyntaxError("Unexpected end of JSON input") });
    const pending = h.save("req-a", c.submission.payload, c); await flush(); h.requests[0].reject(lost); await pending;
    expect(settle).toHaveBeenCalledTimes(1); expect(settle.mock.calls[0][1]).toEqual({ kind: "unknown" });
    expect(h.invalidateHistory).toHaveBeenCalledTimes(1); expect(h.load).toHaveBeenCalledOnce(); expect(h.setCert).not.toHaveBeenCalled();
    expect(h.setError).toHaveBeenCalledWith("The change was saved, but the answer could not be read. Reload the page to see it.");
  });
  it("a save that landed is told once, by saveReadings and not by the seam (#547)", async () => {
    const h = parentHarness(); const c = h.capture("a", "save-a");
    const pending = h.save("req-a", c.submission.payload, c); await flush(); h.requests[0].resolve(detail()); await pending;
    expect(h.invalidateHistory).toHaveBeenCalledTimes(1); expect(h.load).not.toHaveBeenCalled(); expect(h.setError).toHaveBeenCalledWith(null);
  });
  it("marks dispatched only inside the actual serial thunk and refuses discarded queued intent", async () => {
    const h = parentHarness(); const hold = deferred<void>(); h.queue.current.set("readings:req-a", hold.promise);
    const c = h.capture("a", "queued"); const pending = h.save("req-a", c.submission.payload, c); await flush(); expect(h.requests).toHaveLength(0);
    h.a.binding.discard(h.a.binding.getSnapshot().current!.stamp); hold.resolve(); await flush();
    expect(h.requests).toHaveLength(0); await pending;
  });
  it("drains actual sibling request signals before rollback without mutual failure deadlock", async () => {
    const h = parentHarness(); const a = h.capture("a", "a"); const b = h.capture("b", "b");
    const pa = h.save("req-a", a.submission.payload, a); const pb = h.save("req-b", b.submission.payload, b); await flush(); expect(h.requests).toHaveLength(2);
    h.requests[0].reject(new Error("A failed")); await flush(); expect(h.load).not.toHaveBeenCalled();
    h.requests[1].reject(new Error("B failed")); await Promise.all([pa, pb]);
    expect(h.load).toHaveBeenCalledTimes(2); expect(h.a.binding.getSnapshot().current).toBeUndefined(); expect(h.b.binding.getSnapshot().current).toBeUndefined();
  });
  it("does not remount a replacement generation created while rollback GET is pending", async () => {
    const rollback = deferred<CertDetailData>(); const h = parentHarness({ rollback: rollback.promise });
    const c = h.capture("a", "failed"); const pending = h.save("req-a", c.submission.payload, c); await flush();
    h.requests[0].reject(new Error("failed raw request")); await flush();
    expect(h.a.binding.getSnapshot().current).toBeUndefined(); expect(h.load).toHaveBeenCalledOnce();
    const readId = h.a.binding.beginRead(); h.a.binding.acceptRead({ kind: "authorized", readId, baseline: baseline(), editable: true }, clean);
    h.a.binding.change(d => ({ ...d, dirty: true, rows: d.rows.map(r => ({ ...r, note: "created during rollback" })) }));
    const replacement = h.a.binding.getSnapshot().current!.stamp; expect(replacement.generation).not.toBe(c.submission.stamp.generation);
    rollback.resolve(detail()); await pending;
    expect(h.bumpReset).not.toHaveBeenCalled(); expect(h.a.binding.getSnapshot().current!.stamp).toEqual(replacement);
    expect(h.a.binding.getSnapshot().current!.data.rows[0].note).toBe("created during rollback");
  });
  it("late successful raw result cannot clear a new generation created after Discard", async () => {
    const h = parentHarness(); const c = h.capture("a", "old"); const pending = h.save("req-a", c.submission.payload, c); await flush();
    h.a.binding.discard(h.a.binding.getSnapshot().current!.stamp); h.a.binding.change(d => ({ ...d, dirty: true, rows: d.rows.map(r => ({ ...r, note: "new generation" })) }));
    h.requests[0].resolve(detail()); await pending;
    expect(h.a.binding.getSnapshot().current!.data.rows[0].note).toBe("new generation"); expect(h.bumpReset).not.toHaveBeenCalled();
  });
});


describe("cert readings fresh authorization reads", () => {
  async function returned() {
    const h = setup(retiring); const session = createDraftSession(h.store);
    await session.validateIdentity(async () => ({ id: "u1" }));
    const id = h.a.binding.beginRead(); h.a.binding.acceptRead({ kind: "authorized", readId: id, baseline: baseline(), editable: true }, clean);
    h.a.binding.change(d => ({ ...d, dirty: true, rows: d.rows.map(r => ({ ...r, note: "private retained" })) }));
    h.a.detach(); h.a.binding.attach("return"); return { ...h, session };
  }
  for (const scenario of ["no-edit", "printed-refused", "printed-granted", "voided"] as const) it(`applies fresh current editability for ${scenario}`, async () => {
    const h = await returned(); const cert = detail();
    const grants = scenario === "no-edit" ? ["certs.view"] : scenario === "printed-refused" ? permissions : [...permissions, "action.edit_cert_results_after_print"];
    if (scenario !== "no-edit") cert.printedAt = "2026-09-12T12:00:00Z";
    if (scenario === "voided") cert.deletedAt = "2026-09-12T13:00:00Z";
    const accepted = vi.fn();
    const result = await readCertReadings({ binding: h.a.binding, session: h.session, certId: "cert-a", requirementId: "req-a",
      readCert: async () => cert, readIdentity: async () => ({ id: "u1", permissions: grants }), accepted });
    expect(result).toBe(true); expect(accepted).toHaveBeenCalledOnce();
    expect(h.a.binding.getSnapshot().savedBaseline?.printedAt).toBe(cert.printedAt);
    expect(h.a.binding.getSnapshot().canRestore).toBe(scenario === "printed-granted");
    expect(h.a.binding.getSnapshot().mode).toBe(scenario === "printed-granted" ? "offer" : "conflict");
  });
  it("requires actual cert and fresh same-owner view grant before offering Restore", async () => {
    const h = await returned(); const cert = deferred<CertDetailData>(); const identity = deferred<{ id: string; permissions: string[] }>();
    const readCert = vi.fn(() => cert.promise); const readIdentity = vi.fn(() => identity.promise); const accepted = vi.fn();
    const pending = readCertReadings({ binding: h.a.binding, session: h.session, certId: "cert-a", requirementId: "req-a", readCert, readIdentity, accepted });
    expect(h.a.binding.getSnapshot().savedBaseline).toBeUndefined(); cert.resolve(detail()); await flush();
    expect(h.a.binding.getSnapshot().canRestore).toBe(false); identity.resolve({ id: "u1", permissions }); await pending;
    expect(readCert).toHaveBeenCalledOnce(); expect(readIdentity).toHaveBeenCalledOnce(); expect(accepted).toHaveBeenCalledOnce();
    expect(h.a.binding.getSnapshot().mode).toBe("offer"); expect(h.a.binding.restore(h.a.binding.getSnapshot().current!.stamp, accepted.mock.calls[0][0])).toBe(true);
    expect(h.a.binding.getSnapshot().current!.data.rows[0].note).toBe("private retained");
  });
  for (const scenario of ["wrong-owner", "no-view", "missing-child", "wrong-cert", "GET-failed"] as const) it(`hides retained values after ${scenario}`, async () => {
    const h = await returned(); const fresh = detail();
    if (scenario === "missing-child") fresh.requirements = [];
    if (scenario === "wrong-cert") fresh.id = "cert-other";
    const result = await readCertReadings({ binding: h.a.binding, session: h.session, certId: "cert-a", requirementId: "req-a",
      readCert: async () => { if (scenario === "GET-failed") throw new Error("unavailable"); return fresh; },
      readIdentity: async () => ({ id: scenario === "wrong-owner" ? "u2" : "u1", permissions: scenario === "no-view" ? [] : permissions }), accepted: vi.fn() });
    expect(result).toBe(false); expect(h.a.binding.getSnapshot().mode).toBe("unavailable");
    expect(h.a.binding.getSnapshot().current).toBeUndefined(); expect(h.a.binding.getSnapshot().savedBaseline).toBeUndefined();
  });
  for (const change of ["auth", "detached", "newer-read"] as const) it(`rejects a stale pre-await read after ${change}`, async () => {
    const h = await returned(); const cert = deferred<CertDetailData>(); const accepted = vi.fn();
    const pending = readCertReadings({ binding: h.a.binding, session: h.session, certId: "cert-a", requirementId: "req-a", readCert: () => cert.promise,
      readIdentity: async () => ({ id: "u1", permissions }), accepted });
    if (change === "auth") await h.session.validateIdentity(async () => ({ id: "u1" }));
    if (change === "detached") { const detach = h.a.binding.attach("return"); detach(); }
    if (change === "newer-read") h.a.binding.beginRead();
    cert.resolve(detail()); expect(await pending).toBe(false); expect(accepted).not.toHaveBeenCalled(); expect(h.a.binding.getSnapshot().canRestore).toBe(false);
  });
});

describe("actual RequirementBlock live verdict", () => {
  const rowVerdict = actual<(row: unknown, min: number | null, max: number | null) => boolean | null>("RequirementBlock", "rowVerdict", {
    readFinishedDecimal, computePassed,
    VERDICT_BOX: { intDigits: READING_VALUE.box.intDigits, scale: READING_VALUE.box.scale },
  });
  const row = (value: string) => ({ key: 0, value, note: "", overridden: false, passedChoice: "" });
  it.each([[".5", true], ["5", false], ["42.", null], ["", null], ["-.5", false]])("judges a typed reading %j as %s against 0 to 1", (value, verdict) => {
    expect(rowVerdict(row(value), 0, 1)).toBe(verdict);
  });
});

describe("actual RequirementBlock local validation boundary", () => {
  for (const row of [
    { value: "bad", overridden: false, passedChoice: "" },
    { value: "", overridden: true, passedChoice: "pass" },
    { value: "12", overridden: true, passedChoice: "" },
    { value: "12", overridden: false, passedChoice: "", note: "x".repeat(501) },
  ] as const) it(`does not call parent Save for invalid row ${JSON.stringify(row).slice(0, 75)}`, async () => {
    const h = setup(retiring); const rows = [{ key: 0, note: "", ...row }];
    h.a.binding.change(d => ({ ...d, dirty: true, rows }));
    const onSave = vi.fn(); const setLocalError = vi.fn(); const setSaving = vi.fn();
    const save = actual<() => Promise<void>>("RequirementBlock", "save", {
      rows, requirement: baseline().requirement, binding: h.a.binding, onSave, setLocalError, setSaving,
      editGate: { allowed: true, disabled: false, title: undefined }, saving: false,
      prepareCertReadings, newId,
    });
    await save(); expect(onSave).not.toHaveBeenCalled(); expect(setLocalError).toHaveBeenCalled();
    expect(h.a.binding.getSnapshot().current!.data.rows).toEqual(rows);
  });
});


describe("#701: the page's blocks share one cert read and one identity read per task", () => {
  // Two blocks mounting in one commit call readCertReadings in one task; through batched readers
  // (the block's `sharedCertReaders`) that is one cert GET and one /me for both, each block still
  // checking its own ticket and requirement. A read begun after a flight was sent gets its own.
  // Mutation: hand the blocks unbatched readers and the first case reds.
  it("two blocks in one task: one cert read, one identity read, both accepted", async () => {
    const h = setup(certReadingsRecoveryAdapter); const session = createDraftSession(h.store);
    await session.validateIdentity(async () => ({ id: "u1" }));
    const cert = vi.fn(async () => detail()); const me = vi.fn(async () => ({ id: "u1", permissions }));
    const readCert = batchedRead(cert); const readIdentity = batchedRead(me);
    for (const which of ["a", "b"] as const) { h[which].detach(); h[which].binding.attach("return"); }
    const accepted = vi.fn();
    const reads = (["a", "b"] as const).map(which => readCertReadings({ binding: h[which].binding, session, certId: "cert-a", requirementId: which === "a" ? "req-a" : "req-b", readCert, readIdentity, accepted }));
    expect(await Promise.all(reads)).toEqual([true, true]);
    expect(cert).toHaveBeenCalledTimes(1); expect(me).toHaveBeenCalledTimes(1); expect(accepted).toHaveBeenCalledTimes(2);
    expect(h.a.binding.getSnapshot().savedBaseline?.requirement.id).toBe("req-a");
    expect(h.b.binding.getSnapshot().savedBaseline?.requirement.id).toBe("req-b");
  });
  it("a block reading after the flight was sent reads again, never joining it", async () => {
    const h = setup(certReadingsRecoveryAdapter); const session = createDraftSession(h.store);
    await session.validateIdentity(async () => ({ id: "u1" }));
    const cert = vi.fn(async () => detail()); const me = vi.fn(async () => ({ id: "u1", permissions }));
    const readCert = batchedRead(cert); const readIdentity = batchedRead(me);
    for (const which of ["a", "b"] as const) { h[which].detach(); h[which].binding.attach("return"); }
    const first = readCertReadings({ binding: h.a.binding, session, certId: "cert-a", requirementId: "req-a", readCert, readIdentity, accepted: vi.fn() });
    await flush();
    const second = readCertReadings({ binding: h.b.binding, session, certId: "cert-a", requirementId: "req-b", readCert, readIdentity, accepted: vi.fn() });
    expect(await first).toBe(true); expect(await second).toBe(true);
    expect(cert).toHaveBeenCalledTimes(2);
  });
});

describe("#701: the block's wiring, pinned from source", () => {
  const text = readFileSync(new URL("../src/app/certs/[id]/RequirementBlock.tsx", import.meta.url), "utf8");
  it("reads through the page's shared batched readers", () => {
    expect(text).toContain("const readers = sharedCertReaders(certId);");
    expect(text).toContain("readCert: readers.cert,");
    expect(text).toContain("readIdentity: readers.identity,");
  });
  it("re-reads on a gate change except the first false-to-true flip, and the load effect no longer keys on the gate", () => {
    expect(text).toContain("useEffect(() => { void loadRecovery(); }, [loadRecovery, authorizationRevision]);");
    expect(text).toContain("if (!was && now && !gateEverTrue.current) { gateEverTrue.current = true; return; }");
  });
  it("shows the parent's requirement read-only until the block's own read lands", () => {
    expect(text).toContain("const shownRequirement = savedRequirement ?? requirement;");
    expect(text).toContain("{shownRequirement && <>");
    expect(text).not.toMatch(/\{savedRequirement && <>/);
  });
});

describe("review: actual readings save overlaps recovery read", () => {
  for (const outcome of ["persisted", "unknown"] as const) it(`never adopts pre-save readings after ${outcome} settles while access is hidden`, async () => {
    const saved = detail(); saved.requirements[0].readings[0].note = "attempt";
    const h = parentHarness({ adapter: certReadingsRecoveryAdapter, rollback: Promise.resolve(saved) });
    const session = createDraftSession(h.store);
    await session.validateIdentity(async () => ({ id: "u1" }));
    const initialRead = h.a.binding.beginRead();
    h.a.binding.acceptRead({ kind: "authorized", readId: initialRead, baseline: baseline(), editable: true }, clean);
    const captured = h.capture("a", "overlapping-save");
    const save = h.save("req-a", captured.submission.payload, captured); await flush();
    const identity = deferred<{ id: string; permissions: string[] }>();
    let reads = 0; let identityReads = 0;
    const readCert = vi.fn(async () => ++reads === 1 ? detail() : saved);
    const readIdentity = vi.fn(async () => ++identityReads === 1 ? identity.promise : { id: "u1", permissions });
    const reading = readCertReadings({ binding: h.a.binding, session, certId: "cert-a", requirementId: "req-a", readCert, readIdentity, accepted: vi.fn() });
    await flush(); expect(readIdentity).toHaveBeenCalledOnce(); expect(h.a.binding.getSnapshot().current).toBeUndefined();
    if (outcome === "persisted") h.requests[0].resolve(saved);
    else h.requests[0].reject(new Error("response lost after persistence"));
    await save;
    identity.resolve({ id: "u1", permissions }); await reading;
    const after = h.a.binding.getSnapshot();
    expect(readCert).toHaveBeenCalledTimes(2); expect(readIdentity).toHaveBeenCalledTimes(2);
    expect(after.mode).toBe("editing");
    expect(after.current?.data.rows[0].note).toBe("attempt");
    expect(after.savedBaseline?.requirement.readings[0].note).toBe("attempt");
  });
});

// Ruling 28 (P7 step 8): a block's Discard is its own `discardChanges`, run against the real store.
describe("cert readings Discard", () => {
  it("puts the saved readings back, keeps the block editing, leaves its sibling and clears its message", () => {
    const { a, b } = setup();
    a.binding.change(d => ({ ...d, dirty: true, rows: d.rows.map(r => ({ ...r, note: "typed" })) }));
    b.binding.change(d => ({ ...d, dirty: true, rows: d.rows.map(r => ({ ...r, note: "sibling" })) }));
    const before = a.binding.getSnapshot().current!.stamp;
    const setLocalError = vi.fn();
    actual<() => void>("RequirementBlock", "discardChanges", { binding: a.binding, view: a.binding.getSnapshot(), setLocalError })();
    const after = a.binding.getSnapshot();
    expect(after.mode).toBe("editing");
    expect(after.current!.stamp.generation).not.toBe(before.generation);
    expect(after.current!.data.dirty).toBe(false);
    expect(after.current!.data.rows.every(r => r.note !== "typed")).toBe(true);
    expect(b.binding.getSnapshot().current!.data.rows[0].note).toBe("sibling");
    expect(setLocalError).toHaveBeenCalledWith(null);
  });
  it("the Discard button is the block's own, held while its save is out", () => {
    const text = readFileSync(new URL("../src/app/certs/[id]/RequirementBlock.tsx", import.meta.url), "utf8");
    expect(text).toContain('<DiscardButton section="Cert results" dirty={dirty} pending={saving} onDiscard={discardChanges} />');
  });
});
