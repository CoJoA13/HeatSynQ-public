import { describe, expect, it, vi } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import { CERT_DEFAULT_CONFIG } from "../src/lib/template-contracts";
import { documentTemplateRecoveryAdapter, documentTemplateDraftFrom, runDocumentTemplateSave, readDocumentTemplate,
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

describe("actual 409 helper combined with ordinary return read", () => {
  for (const firstRead of ["held identity", "late GET failure"] as const) it(`${firstRead} after final rejected settlement requires exactly one fresh continuation`, async () => {
    const h = fixture(); const rollback = deferred<DocumentTemplateDetail>(); h.args.readDetail = () => rollback.promise;
    const saving = runDocumentTemplateSave(h.args); await tick(); expect(h.patch).toHaveBeenCalledTimes(1);
    h.detach(); h.binding.attach("return");
    const get = deferred<DocumentTemplateDetail>(); const me = deferred<{ id: string; permissions: string[] }>();
    const readDetail = vi.fn().mockImplementationOnce(() => firstRead === "late GET failure" ? get.promise : Promise.resolve({ ...fresh(), draft: { ...fresh().draft!, config: config("obsolete saved"), updatedAt: base().updatedAt } })).mockImplementation(async () => fresh());
    const readIdentity = vi.fn().mockImplementationOnce(() => firstRead === "held identity" ? me.promise : Promise.resolve({ id: "u1", permissions })).mockImplementation(async () => ({ id: "u1", permissions }));
    const accepted = vi.fn();
    const reading = readDocumentTemplate({ binding: h.binding, session: h.session, templateId: "t", versionNumber: 1, readDetail, readIdentity, accepted });
    await tick(); expect(readDetail).toHaveBeenCalledTimes(1);
    expect(h.binding.getSnapshot().canRestore).toBe(false); expect(h.binding.getSnapshot().current).toBeUndefined();
    rollback.resolve(fresh()); await saving;
    if (firstRead === "late GET failure") get.reject({ status: 503 }); else me.resolve({ id: "u1", permissions });
    expect(await reading).toBe(true);
    // Both reads of an attempt go out together (#676), so the attempt whose GET fails late has
    // already sent its identity read: two in both lanes (one per attempt).
    expect(readDetail).toHaveBeenCalledTimes(2); expect(readIdentity).toHaveBeenCalledTimes(2);
    expect(accepted).toHaveBeenCalledTimes(1);
    const view = h.binding.getSnapshot();
    expect(view.savedBaseline?.updatedAt).toBe(fresh().draft!.updatedAt);
    expect(view.current?.data.updatedAt).toBe(fresh().draft!.updatedAt);
    expect(view.current?.data.config.textBlocks.cert_statement).toBe("server");
    expect(view.current?.data.stashed?.textBlocks.cert_statement).toBe("attempt");
    expect(view.current?.data.dirty).toBe(false); expect(view.canRestore).toBe(true);
    expect(h.patch).toHaveBeenCalledTimes(1); expect(h.onSaved).not.toHaveBeenCalled();
  });
  it("a second real rejected settlement invalidates the sole continuation and leaves blocked without a third GET", async () => {
    const h = fixture(); const rollback = deferred<DocumentTemplateDetail>(); h.args.readDetail = () => rollback.promise;
    const firstSaving = runDocumentTemplateSave(h.args); await tick(); expect(h.patch).toHaveBeenCalledTimes(1);
    const data = h.binding.getSnapshot().current!.data;
    const second = h.binding.capture({ config: data.config, updatedAt: data.updatedAt, epoch: data.epoch }, "second-save");
    h.detach(); h.binding.attach("return");
    const firstMe = deferred<{ id: string; permissions: string[] }>(); const secondMe = deferred<{ id: string; permissions: string[] }>();
    const readDetail = vi.fn(async () => fresh());
    const readIdentity = vi.fn().mockImplementationOnce(() => firstMe.promise).mockImplementationOnce(() => secondMe.promise).mockImplementation(async () => ({ id: "u1", permissions }));
    const accepted = vi.fn();
    const reading = readDocumentTemplate({ binding: h.binding, session: h.session, templateId: "t", versionNumber: 1, readDetail, readIdentity, accepted });
    await tick(); expect(readDetail).toHaveBeenCalledTimes(1);
    rollback.resolve(fresh()); await firstSaving; firstMe.resolve({ id: "u1", permissions }); await tick();
    expect(readDetail).toHaveBeenCalledTimes(2); expect(readIdentity).toHaveBeenCalledTimes(2);
    const secondPatch = vi.fn(async () => { throw { status: 409 }; });
    await runDocumentTemplateSave({ ...h.args, submission: second, patch: secondPatch,
      readDetail: async () => ({ ...fresh(), draft: { ...fresh().draft!, updatedAt: "2026-09-12T02:00:00.000Z" } }) });
    expect(secondPatch).toHaveBeenCalledTimes(1);
    secondMe.resolve({ id: "u1", permissions }); expect(await reading).toBe(false);
    expect(readDetail).toHaveBeenCalledTimes(2); expect(readIdentity).toHaveBeenCalledTimes(2); expect(accepted).not.toHaveBeenCalled();
    expect(h.binding.getSnapshot().canRestore).toBe(false); expect(h.binding.getSnapshot().current).toBeUndefined();
    expect(h.binding.getSnapshot().savedBaseline).toBeUndefined();
  });
});
