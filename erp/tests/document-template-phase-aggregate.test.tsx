import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createDraftStore, type Adapter } from "../src/lib/draft-store";
import { DraftRecoveryNotice } from "../src/components/DraftRecoveryNotice";
function fixture() {
  const adapter: Adapter<string, string, string, string> & { allowRejectedFollowUp: boolean } = {
    kind: "aggregate", schema: "1", allowRejectedFollowUp: true, valid: () => true, dirty: (a, b) => a !== b, baselineEqual: (a, b) => a === b,
    preview: () => [], reconcileRead: ({ current }) => ({ data: current.data, baseline: current.baseline }),
    settle: ({ current }) => ({ kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: false }),
  };
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u")!;
  const binding = store.bind({ owner, record: { kind: "document-template", id: "t" }, editor: adapter.kind }, { label: "Template", href: "/t" }, adapter);
  const detach = binding.attach("live"); binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline: "saved", editable: true }, "saved");
  binding.change(() => "first"); const first = binding.capture("first", "first"); binding.dispatched(first);
  binding.change(() => "second"); const second = binding.capture("second", "second"); binding.dispatched(second);
  const mark = (submission: typeof first) => (binding as typeof binding & { noteRejectedSubmission?: (s: typeof first) => boolean }).noteRejectedSubmission?.(submission) ?? false;
  return { store, binding, first, second, mark, detach };
}
describe("aggregate pending rejection phase", () => {
  it("keeps transport while any request is unmarked; marking second and settling last notify view and row", () => {
    const h = fixture(); const viewChanged = vi.fn(); const rowsChanged = vi.fn();
    const offView = h.binding.subscribe(viewChanged); const offRows = h.store.subscribe(rowsChanged);
    const phase = (expected: "transport" | "rollback") => {
      expect(h.binding.getSnapshot()).toEqual(expect.objectContaining({ submissionPhase: expected }));
      expect(h.store.getSnapshot().rows[0]).toEqual(expect.objectContaining({ submissionPhase: expected }));
    };
    try {
      phase("transport"); expect(h.mark(h.first)).toBe(true); phase("transport");
      viewChanged.mockClear(); rowsChanged.mockClear(); expect(h.mark(h.second)).toBe(true); phase("rollback");
      expect(viewChanged).toHaveBeenCalled(); expect(rowsChanged).toHaveBeenCalled();
      h.binding.settle(h.first, { kind: "rejected" }); phase("rollback");
      viewChanged.mockClear(); rowsChanged.mockClear(); h.binding.settle(h.second, { kind: "rejected" });
      expect(h.binding.getSnapshot()).not.toHaveProperty("submissionPhase"); expect(h.store.getSnapshot().rows[0]).not.toHaveProperty("submissionPhase");
      expect(viewChanged).toHaveBeenCalled(); expect(rowsChanged).toHaveBeenCalled();
    } finally { offView(); offRows(); }
  });
  it("records raw refusal while identity checking hides payloads, then remount exposes phase only after fresh access", () => {
    const h = fixture(); const stamps = h.store.getSnapshot().rows[0].stamps;
    const check = h.store.beginIdentityCheck(); h.detach();
    expect(h.mark(h.first)).toBe(true); expect(h.mark(h.second)).toBe(true);
    expect(h.binding.getSnapshot().current).toBeUndefined(); expect(h.binding.getSnapshot().reference).toBeUndefined();
    expect(h.binding.getSnapshot().submitted).toBeUndefined(); expect(h.store.getSnapshot().rows).toEqual([]);
    h.store.acceptIdentity(check, "u"); h.binding.attach("return");
    expect(h.binding.getSnapshot().submitted).toBeUndefined(); expect(h.binding.getSnapshot().current).toBeUndefined();
    const readId = h.binding.beginRead();
    h.binding.acceptRead({ kind: "authorized", readId, baseline: "saved", editable: true }, "saved");
    expect(h.binding.getSnapshot()).toEqual(expect.objectContaining({ mode: "pending", submissionPhase: "rollback", canRestore: false }));
    expect(h.binding.getSnapshot().submitted?.data).toBe("second");
    expect(h.store.getSnapshot().rows[0]).toEqual(expect.objectContaining({ submissionPhase: "rollback", stamps }));
  });
  it("settling the marked request first preserves the unmarked transport and its independent outcome", () => {
    const h = fixture(); expect(h.mark(h.first)).toBe(true);
    h.binding.settle(h.first, { kind: "rejected" });
    expect(h.binding.getSnapshot()).toEqual(expect.objectContaining({ submissionPhase: "transport" }));
    expect(h.binding.getSnapshot().submitted?.data).toBe("second");
    expect(h.store.getSnapshot().rows[0]).toEqual(expect.objectContaining({ pending: true, submissionPhase: "transport" }));
    h.binding.settle(h.second, { kind: "persisted", response: "ok" });
    expect(h.binding.getSnapshot().submitted).toBeUndefined();
    expect(h.binding.getSnapshot()).not.toHaveProperty("submissionPhase");
    expect(h.store.getSnapshot().rows[0].pending).toBe(false);
  });
  it("settling the unmarked request reveals the other request's already-known rollback phase", () => {
    const h = fixture(); expect(h.mark(h.first)).toBe(true);
    h.binding.settle(h.second, { kind: "persisted", response: "ok" });
    expect(h.binding.getSnapshot()).toEqual(expect.objectContaining({ submissionPhase: "rollback" }));
    expect(h.store.getSnapshot().rows[0]).toEqual(expect.objectContaining({ submissionPhase: "rollback" }));
  });
});
function notice(mode: "pending" | "unknown" | "editing", submissionPhase?: "transport" | "rollback") {
  const props = { mode, submissionPhase, canRestore: false, hasCurrent: true, hasReference: false,
    restore: vi.fn(), discard: vi.fn(), retryRead: vi.fn() };
  return renderToStaticMarkup(<DraftRecoveryNotice {...props} />);
}
function rowMarkup(submissionPhase?: "transport" | "rollback") {
  const source = ts.createSourceFile("DraftsInTab.tsx", readFileSync(new URL("../src/components/DraftsInTab.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "AuthorizedRow");
  expect(node).toBeDefined();
  const code = ts.transpileModule(`return (${node!.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
  // Execute the actual row renderer, with inert hooks only; no fake replacement JSX.
  const Row = new Function("React", "useState", "useEffect", "Link", "peekBrowserDraftSession", "labelReaders", "labelFor", code)(React,
    (initial: unknown) => [initial, vi.fn()], () => undefined, (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
    () => null, {}, () => null) as React.ComponentType<{ row: unknown }>;
  return renderToStaticMarkup(<Row row={{ key: { record: { kind: "document-template", id: "t" } }, metadata: { label: "Template", href: "/t" }, stamps: [], pending: true, submissionPhase }} />);
}
describe("actual pending wording consumers", () => {
  it("Notice says rejected and refreshing only for rollback, preserving default and unknown wording", () => {
    expect(notice("pending", "rollback")).toMatch(/rejected/i); expect(notice("pending", "rollback")).toMatch(/refresh/i);
    expect(notice("pending")).toContain("A save is in progress."); expect(notice("pending", "transport")).toContain("A save is in progress.");
    expect(notice("unknown", "rollback")).toContain("The save result is unknown."); expect(notice("unknown", "rollback")).not.toMatch(/rejected/i);
  });
  it("live editing also reports a known refusal while its refresh is pending", () => {
    expect(notice("editing", "rollback")).toMatch(/rejected/i);
    expect(notice("editing", "rollback")).toMatch(/refresh/i);
    expect(notice("editing")).toBe("");
  });
  it("actual DraftsInTab row renders rollback wording from its aggregate without changing default", () => {
    expect(rowMarkup("rollback")).toMatch(/rejected/i); expect(rowMarkup("rollback")).toMatch(/refresh/i);
    expect(rowMarkup()).toContain("save pending"); expect(rowMarkup("transport")).toContain("save pending");
  });
});
