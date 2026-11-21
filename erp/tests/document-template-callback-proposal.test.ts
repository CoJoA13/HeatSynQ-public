import { describe, expect, it, vi } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import { CERT_DEFAULT_CONFIG } from "../src/lib/template-contracts";
import { documentTemplateRecoveryAdapter, documentTemplateDraftFrom, runDocumentTemplateSave,
  type DocumentTemplateBaseline, type DocumentTemplateDetail, type DocumentTemplateSaveArgs } from "../src/lib/document-template-recovery";
const permissions = ["templates.view", "templates.edit"];
const config = (text: string) => ({ ...structuredClone(CERT_DEFAULT_CONFIG), textBlocks: { cert_statement: text } });
const base = (): DocumentTemplateBaseline => ({ source: "open", status: "DRAFT", templateId: "t", docType: "CERT", versionNumber: 1,
  config: config("saved"), updatedAt: "2026-09-12T00:00:00.000Z", logoMimeType: null, permissions });
const fresh = (): DocumentTemplateDetail => ({ id: "t", docType: "CERT", name: "Owned", draft: {
  versionNumber: 1, config: config("server"), updatedAt: "2026-09-12T01:00:00.000Z", logoMimeType: null } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture() {
  const store = createDraftStore(); const session = createDraftSession(store);
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  // Literal admission/equality isolates the actual callback from the inert domain adapter.
  const adapter = { ...documentTemplateRecoveryAdapter, valid: () => true,
    dirty: (d: ReturnType<typeof documentTemplateDraftFrom>) => d.dirty || d.stashed !== null,
    baselineEqual: (a: DocumentTemplateBaseline, b: DocumentTemplateBaseline) => JSON.stringify(a) === JSON.stringify(b) };
  const key = { owner, record: { kind: "document-template", id: "t" }, editor: adapter.kind, entityVersion: "1" };
  const binding = store.bind(key, { label: "Template", href: "/admin/templates/t/edit" }, adapter);
  let live = true; const detachBinding = binding.attach("original");
  const detach = () => { live = false; detachBinding(); }; const b = base();
  binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline: b, editable: true }, documentTemplateDraftFrom(b));
  const edit = (text: string) => binding.change(d => ({ ...d, config: config(text), epoch: d.epoch + 1, dirty: true }));
  edit("attempt"); const d = binding.getSnapshot().current!.data;
  const submission = binding.capture({ config: d.config, updatedAt: d.updatedAt, epoch: d.epoch }, "save");
  const patch = vi.fn(async () => { throw { status: 409 }; });
  const readDetail = vi.fn(async () => fresh()); const readIdentity = vi.fn(async () => ({ id: "u1", permissions }));
  const onSaved = vi.fn(); const onConflict = vi.fn(); const onError = vi.fn();
  const args: DocumentTemplateSaveArgs = { binding, session, submission, patch, readDetail, readIdentity, onSaved, onConflict, onError, isLive: () => live };
  return { store, session, binding, adapter, detach, edit, submission, args, patch, readDetail, readIdentity, onSaved, onConflict, onError };
}

describe("actual document-template save helper proposal", () => {
  for (const boundary of ["entity", "identity"] as const) it(`same-user revalidation during held rollback ${boundary} refuses original authorization`, async () => {
    const h = fixture(); const entity = deferred<DocumentTemplateDetail>(); const identity = deferred<{ id: string; permissions: string[] }>();
    h.args.readDetail = vi.fn(() => boundary === "entity" ? entity.promise : Promise.resolve(fresh()));
    h.args.readIdentity = vi.fn(() => boundary === "identity" ? identity.promise : Promise.resolve({ id: "u1", permissions }));
    const settle = vi.spyOn(h.binding, "settle");
    try {
      const running = runDocumentTemplateSave(h.args); await tick();
      expect(h.patch).toHaveBeenCalledTimes(1); expect(h.args.readDetail).toHaveBeenCalledTimes(1);
      expect(settle).not.toHaveBeenCalled();
      expect(h.binding.getSnapshot()).toEqual(expect.objectContaining({ submissionPhase: "rollback" }));
      await h.session.validateIdentity(async () => ({ id: "u1" }));
      entity.resolve(fresh()); identity.resolve({ id: "u1", permissions }); await running;
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(h.submission, { kind: "rejected", response: { kind: "conflict", rollback: { kind: "failed" } } });
      expect(h.binding.getSnapshot().current).toBeUndefined(); expect(h.onSaved).not.toHaveBeenCalled(); expect(h.onConflict).not.toHaveBeenCalled();
    } finally { settle.mockRestore(); }
  });
  for (const boundary of ["entity", "identity"] as const) for (const change of ["detach", "later edit", "replacement"] as const)
    it(`${change} while rollback ${boundary} is held cannot replace a newer dataset`, async () => {
      const h = fixture(); const entity = deferred<DocumentTemplateDetail>(); const identity = deferred<{ id: string; permissions: string[] }>();
      h.args.readDetail = vi.fn(() => boundary === "entity" ? entity.promise : Promise.resolve(fresh()));
      h.args.readIdentity = vi.fn(() => boundary === "identity" ? identity.promise : Promise.resolve({ id: "u1", permissions }));
      const settle = vi.spyOn(h.binding, "settle");
      try {
        const running = runDocumentTemplateSave(h.args); await tick(); expect(h.patch).toHaveBeenCalledTimes(1);
        expect(h.args.readDetail).toHaveBeenCalledTimes(1); expect(settle).not.toHaveBeenCalled();
        if (change === "detach") h.detach();
        if (change === "later edit") h.edit("later raw");
        if (change === "replacement") { h.binding.discard(h.binding.getSnapshot().current!.stamp); h.edit("replacement raw"); }
        const retained = h.binding.getSnapshot().current;
        entity.resolve(fresh()); identity.resolve({ id: "u1", permissions }); await running;
        expect(settle).toHaveBeenCalledTimes(1); expect(settle.mock.calls[0][0]).toBe(h.submission);
        expect(settle.mock.calls[0][1].kind).toBe("rejected"); expect(h.onSaved).not.toHaveBeenCalled();
        if (change === "detach") expect(h.onConflict).not.toHaveBeenCalled();
        else {
          expect(h.binding.getSnapshot().current?.stamp.generation).toBe(retained?.stamp.generation);
          expect(h.binding.getSnapshot().current?.data.config.textBlocks.cert_statement).toBe(change === "later edit" ? "later raw" : "replacement raw");
          expect(h.binding.getSnapshot().current?.data.stashed).toBeNull();
        }
      } finally { settle.mockRestore(); }
    });
  it("rollback GET failure still finalizes one rejected outcome and preserves later raw work", async () => {
    const h = fixture(); const held = deferred<DocumentTemplateDetail>(); h.args.readDetail = () => held.promise;
    const settle = vi.spyOn(h.binding, "settle");
    try {
      const running = runDocumentTemplateSave(h.args); await tick(); expect(h.patch).toHaveBeenCalledTimes(1);
      h.edit("later raw"); held.reject({ status: 503 }); await running;
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(h.submission, { kind: "rejected", response: { kind: "conflict", rollback: { kind: "failed" } } });
      expect(h.binding.getSnapshot().current?.data.config.textBlocks.cert_statement).toBe("later raw");
      expect(h.binding.getSnapshot().submitted).toBeUndefined(); expect(h.onSaved).not.toHaveBeenCalled();
    } finally { settle.mockRestore(); }
  });
  it("raw PATCH200 settles persisted before throwing UI without refusal rollback", async () => {
    const h = fixture(); const events: string[] = []; const original = h.binding.settle;
    h.args.patch = vi.fn(async () => ({ updatedAt: "2026-09-12T02:00:00.000Z" }));
    h.args.onSaved = () => { events.push("UI"); throw new Error("UI failed"); };
    const settle = vi.spyOn(h.binding, "settle").mockImplementation((submission, outcome) => { events.push(outcome.kind); return original(submission, outcome); });
    try {
      await runDocumentTemplateSave(h.args).catch(() => undefined);
      expect(events).toEqual(["persisted", "UI"]); expect(settle).toHaveBeenCalledTimes(1);
      expect(h.readDetail).not.toHaveBeenCalled(); expect(h.onError).not.toHaveBeenCalled(); expect(h.onConflict).not.toHaveBeenCalled();
    } finally { settle.mockRestore(); }
  });
});

it("an old callback stays non-live after the same binding gains a new lease, but still settles the raw result", async () => {
  const h = fixture(); const held = deferred<{ updatedAt: string }>(); h.args.patch = vi.fn(() => held.promise);
  const settle = vi.spyOn(h.binding, "settle"); const instanceIsLive = h.args.isLive;
  h.args.isLive = vi.fn(() => { expect(settle).toHaveBeenCalledTimes(1); return instanceIsLive(); });
  try {
    const saving = runDocumentTemplateSave(h.args); await tick(); expect(h.args.patch).toHaveBeenCalledTimes(1);
    expect(h.args.isLive).not.toHaveBeenCalled();
    h.detach(); const detachNew = h.binding.attach("new-instance");
    try {
      const baseline = base();
      h.binding.acceptRead({ kind: "authorized", readId: h.binding.beginRead(), baseline, editable: true }, documentTemplateDraftFrom(baseline));
      expect(h.binding.getSnapshot().current?.stamp.generation).toBe(h.submission.stamp.generation);
      expect(instanceIsLive()).toBe(false);
      held.resolve({ updatedAt: "2026-09-12T02:00:00.000Z" }); await saving;
      expect(h.args.isLive).toHaveBeenCalled();
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(h.submission, { kind: "persisted", response: { kind: "saved", updatedAt: "2026-09-12T02:00:00.000Z" } });
      expect(h.onSaved).not.toHaveBeenCalled(); expect(h.onConflict).not.toHaveBeenCalled(); expect(h.onError).not.toHaveBeenCalled();
    } finally { detachNew(); }
  } finally { settle.mockRestore(); }
});
