import { describe, expect, it, vi } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import { CERT_DEFAULT_CONFIG } from "../src/lib/template-contracts";
import { documentTemplateRecoveryAdapter, documentTemplateDraftFrom, prepareDocumentTemplate, readDocumentTemplateMetadata,
  type DocumentTemplateBaseline, type DocumentTemplateDetail } from "../src/lib/document-template-recovery";
const permissions = ["templates.view", "templates.edit"];
const config = (text: string) => ({ ...structuredClone(CERT_DEFAULT_CONFIG), textBlocks: { cert_statement: text } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const READ_AT = "2026-09-12T00:00:00.000Z"; const CONFLICT_AT = "2026-09-12T00:30:00.000Z"; const FRESH_AT = "2026-09-12T01:00:00.000Z";
function fixture({ real = false, startLogo = null as string | null, freshLogo = "image/png" as string | null } = {}) {
  const store = createDraftStore(); const session = createDraftSession(store); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const adapter: typeof documentTemplateRecoveryAdapter = real ? documentTemplateRecoveryAdapter : { ...documentTemplateRecoveryAdapter, allowEditRead: true, valid: () => true,
    dirty: (d: ReturnType<typeof documentTemplateDraftFrom>) => d.dirty, baselineEqual: (a: DocumentTemplateBaseline, b: DocumentTemplateBaseline) => JSON.stringify(a) === JSON.stringify(b) };
  const binding = store.bind({ owner, record: { kind: "document-template", id: "t" }, editor: adapter.kind, entityVersion: "1" }, { label: "Template", href: "/admin/templates/t/edit" }, adapter);
  const detach = binding.attach("editor");
  const baseline: DocumentTemplateBaseline = { source: "open", status: "DRAFT", templateId: "t", docType: "CERT", versionNumber: 1,
    config: config("OLD saved config"), updatedAt: READ_AT, logoMimeType: startLogo, permissions };
  binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline, editable: true }, documentTemplateDraftFrom(baseline));
  const edit = (text: string) => binding.change(d => ({ ...d, dirty: true, epoch: d.epoch + 1, config: config(text) }));
  edit("initial raw"); const expectedStamp = binding.getSnapshot().current!.stamp;
  // The server's config is still the one this tab's baseline holds: only the logo moved (#460).
  const fresh: DocumentTemplateDetail = { id: "t", docType: "CERT", name: "Owned", draft: { versionNumber: 1,
    config: config("OLD saved config"), updatedAt: FRESH_AT, logoMimeType: freshLogo } };
  const readDetail = vi.fn(async () => fresh); const readIdentity = vi.fn(async () => ({ id: "u1", permissions }));
  const args = { binding, session, expectedStamp, readDetail, readIdentity };
  return { store, session, binding, detach, edit, baseline, fresh, args, readDetail, readIdentity };
}
describe("document-template real metadata callback helper proposal", () => {
  it("captures edit authority before GET and preserves later raw plus OLD saved config while metadata advances", async () => {
    const h = fixture(); const held = deferred<DocumentTemplateDetail>(); h.readDetail.mockImplementation(() => held.promise);
    const begin = vi.spyOn(h.binding, "beginEditRead"); const originalRead = h.args.readDetail;
    h.args.readDetail = vi.fn(() => { expect(begin).toHaveBeenCalledTimes(1); return originalRead(); });
    try {
      const running = readDocumentTemplateMetadata(h.args); await tick(); expect(h.args.readDetail).toHaveBeenCalledTimes(1);
      h.edit("  later raw\nlast event  "); const later = h.binding.getSnapshot().current!;
      held.resolve(h.fresh); expect(await running).toBe(true);
      const current = h.binding.getSnapshot().current!;
      expect(current.stamp.generation).toBe(later.stamp.generation); expect(current.data.epoch).toBe(later.data.epoch);
      expect(current.data.config).toEqual(later.data.config); expect(current.data.dirty).toBe(true);
      expect(current.baseline.config.textBlocks.cert_statement).toBe("OLD saved config");
      expect(current.data.updatedAt).toBe(h.fresh.draft!.updatedAt); expect(current.data.logoMimeType).toBe("image/png");
      expect(current.baseline).toEqual(expect.objectContaining({ source: "open", updatedAt: h.fresh.draft!.updatedAt, logoMimeType: "image/png" }));
    } finally { begin.mockRestore(); }
  });
  it("wrong returned version refuses metadata without altering either config", async () => {
    const h = fixture(); h.readDetail.mockResolvedValue({ ...h.fresh, draft: { ...h.fresh.draft!, versionNumber: 2 } });
    const original = h.binding.getSnapshot().current;
    expect(await readDocumentTemplateMetadata(h.args)).toBe(false); expect(h.readDetail).toHaveBeenCalledTimes(1);
    expect(h.binding.getSnapshot().mode).toBe("unavailable"); expect(h.binding.getSnapshot().current).toBeUndefined();
    expect(() => h.binding.capture({ config: original!.data.config, updatedAt: original!.data.updatedAt, epoch: original!.data.epoch }, "wrong-version-save")).toThrow();
    const readId = h.binding.beginRead();
    h.binding.acceptRead({ kind: "authorized", readId, baseline: original!.baseline, editable: true }, documentTemplateDraftFrom(original!.baseline));
    expect(h.binding.getSnapshot().current?.data).toEqual(original!.data);
    expect(h.binding.getSnapshot().current?.baseline).toEqual(original!.baseline);
  });
  for (const event of ["detach", "replacement"] as const) it(`${event} during metadata GET cannot adopt into the old or new generation`, async () => {
    const h = fixture(); const held = deferred<DocumentTemplateDetail>(); h.readDetail.mockImplementation(() => held.promise);
    const running = readDocumentTemplateMetadata(h.args); await tick(); expect(h.readDetail).toHaveBeenCalledTimes(1);
    if (event === "detach") h.detach();
    else { h.binding.discard(h.binding.getSnapshot().current!.stamp); h.edit("replacement raw"); }
    const afterEvent = h.binding.getSnapshot().current;
    held.resolve(h.fresh); expect(await running).toBe(false);
    expect(h.binding.getSnapshot().current).toBe(afterEvent);
    if (afterEvent) expect(afterEvent.data.logoMimeType).toBeNull();
  });
  it("same-user revalidation during held me hides values and refuses old metadata authority", async () => {
    const h = fixture(); const held = deferred<{ id: string; permissions: string[] }>(); h.readIdentity.mockImplementation(() => held.promise);
    const running = readDocumentTemplateMetadata(h.args); await tick(); expect(h.readIdentity).toHaveBeenCalledTimes(1);
    await h.session.validateIdentity(async () => ({ id: "u1" })); held.resolve({ id: "u1", permissions });
    expect(await running).toBe(false); expect(h.binding.getSnapshot().current).toBeUndefined();
    expect(h.binding.getSnapshot().reference).toBeUndefined();
  });
  // #459 (owner ruling 2026-11-02): a keystroke typed after the render that captured the stamp (in
  // another panel while the logo uploaded) no longer stops the read. The read used to refuse here, so
  // the copy kept the pre-upload updatedAt and the next save met an avoidable 409.
  it("a keystroke after the render that captured the stamp does not stop the read (#459)", async () => {
    const h = fixture(); h.edit("typed while the logo uploaded"); const typed = h.binding.getSnapshot().current!;
    expect(await readDocumentTemplateMetadata(h.args)).toBe(true); expect(h.readDetail).toHaveBeenCalledTimes(1);
    const current = h.binding.getSnapshot().current!;
    expect(current.stamp.generation).toBe(typed.stamp.generation); expect(current.data.config).toEqual(typed.data.config);
    expect(current.data.updatedAt).toBe(FRESH_AT); expect(current.data.logoMimeType).toBe("image/png");
    expect(prepareDocumentTemplate(h.binding, "save-after-logo")?.payload.updatedAt).toBe(FRESH_AT);
  });
  it("a copy replaced after the render that captured the stamp starts no metadata GET", async () => {
    const h = fixture(); h.binding.discard(h.binding.getSnapshot().current!.stamp); h.edit("a new copy"); const original = h.binding.getSnapshot().current;
    expect(await readDocumentTemplateMetadata(h.args)).toBe(false); expect(h.readDetail).not.toHaveBeenCalled();
    expect(h.readIdentity).not.toHaveBeenCalled(); expect(h.binding.getSnapshot().current).toBe(original);
  });
  // #460 (owner ruling 2026-11-02): another admin saved the config between this tab's read and its
  // logo change. Adopting the server's updatedAt over this tab's older config would let its next save
  // pass the server's updatedAt check and overwrite their change, so the read adopts nothing: the copy
  // keeps its own updatedAt, the next save meets the existing 409, and Re-apply my changes follows.
  it("another admin's saved config makes the read adopt nothing, so the next save meets the conflict (#460)", async () => {
    const h = fixture(); h.readDetail.mockResolvedValue({ ...h.fresh, draft: { ...h.fresh.draft!, config: config("saved by another admin") } });
    h.edit("typed while the logo uploaded"); const before = h.binding.getSnapshot().current!;
    // Asked with the current stamp, so only the config comparison can refuse it.
    expect(await readDocumentTemplateMetadata({ ...h.args, expectedStamp: before.stamp })).toBe(false);
    expect(h.readDetail).toHaveBeenCalledTimes(1);
    const view = h.binding.getSnapshot();
    expect(view.mode).toBe("editing"); expect(view.current).toBe(before);
    expect(view.current!.data.updatedAt).toBe(READ_AT); expect(view.current!.data.logoMimeType).toBeNull();
    expect(view.current!.baseline.config.textBlocks.cert_statement).toBe("OLD saved config");
    expect(prepareDocumentTemplate(h.binding, "save-after-logo")?.payload.updatedAt).toBe(READ_AT);
  });
  it("a refused read does not stop a later read whose config matches from adopting", async () => {
    const h = fixture(); h.readDetail.mockResolvedValueOnce({ ...h.fresh, draft: { ...h.fresh.draft!, config: config("saved by another admin") } });
    expect(await readDocumentTemplateMetadata(h.args)).toBe(false);
    expect(await readDocumentTemplateMetadata(h.args)).toBe(true);
    expect(h.binding.getSnapshot().current!.data.updatedAt).toBe(FRESH_AT);
  });
});

// #455 (owner ruling 2026-10-05: fix it in the adapter, not the store). An edit read advances the
// current copy and the access baseline but not the store's clean copy, so a discard that rebuilds
// from clean must take updatedAt and logoMimeType from the baseline. These run the real adapter:
// the fixture's permissive one accepts any rebuilt copy.
describe("a discard after a metadata edit read rebuilds on the baseline's updatedAt and logo type (#455)", () => {
  /** The rebuilt copy is clean editing; its updatedAt, its logo type and the next save's updatedAt are the given values, exactly. */
  function expectRebuilt(h: ReturnType<typeof fixture>, updatedAt: string, logoMimeType: string | null) {
    const view = h.binding.getSnapshot();
    expect(view.mode).toBe("editing"); expect(view.reference).toBeUndefined(); expect(view.current!.data.dirty).toBe(false);
    expect(view.current!.data.config.textBlocks.cert_statement).toBe(view.savedBaseline!.config.textBlocks.cert_statement);
    expect.soft(view.current!.data.updatedAt).toBe(updatedAt);
    expect.soft(view.current!.data.logoMimeType).toBe(logoMimeType);
    h.edit("typed after the discard");
    expect.soft(prepareDocumentTemplate(h.binding, "save-after-discard")?.payload.updatedAt).toBe(updatedAt);
  }
  async function editRead(h: ReturnType<typeof fixture>) {
    expect(await readDocumentTemplateMetadata({ ...h.args, expectedStamp: h.binding.getSnapshot().current!.stamp })).toBe(true);
    expect.soft(h.binding.getSnapshot().savedBaseline).toEqual(expect.objectContaining({ updatedAt: FRESH_AT, logoMimeType: h.fresh.draft!.logoMimeType }));
  }
  it("from the Shell's drafts panel", async () => {
    const h = fixture({ real: true }); await editRead(h);
    h.store.discard(h.store.getSnapshot().rows[0].stamps);
    expectRebuilt(h, FRESH_AT, "image/png");
  });
  it("from the editor's notice, after a conflict and Start fresh: current copy first, earlier copy last", async () => {
    const h = fixture({ real: true }); h.detach(); h.binding.attach("editor-return");
    const conflicting: DocumentTemplateBaseline = { ...h.baseline, config: config("saved by someone else"), updatedAt: CONFLICT_AT };
    const readId = h.binding.beginRead();
    expect(h.binding.acceptRead({ kind: "authorized", readId, baseline: conflicting, editable: true }, documentTemplateDraftFrom(conflicting))).toBe(true);
    expect(h.binding.getSnapshot().mode).toBe("conflict");
    expect(h.binding.startFresh(readId, documentTemplateDraftFrom(conflicting))).toBe(true);
    // The server holds the other admin's config now, which starting fresh made this tab's baseline.
    h.readDetail.mockResolvedValue({ ...h.fresh, draft: { ...h.fresh.draft!, config: config("saved by someone else") } });
    h.edit("typed after starting fresh"); await editRead(h);
    const view = h.binding.getSnapshot(); expect(view.mode).toBe("editing"); expect(view.reference).toBeDefined();
    h.binding.discard(view.current!.stamp);
    expect(h.binding.getSnapshot().mode).toBe("conflict"); expect(h.binding.getSnapshot().current).toBeUndefined();
    h.binding.discard(view.reference!.stamp);
    expectRebuilt(h, FRESH_AT, "image/png");
  });
  // The open loader hands acceptRead a copy built from the baseline it read, so the clean copy
  // already holds a conflicting read's config: the carried updatedAt never rides older config.
  it("after a conflicting ordinary read, discarding the retained changes rebuilds on that read's config and updatedAt", () => {
    const h = fixture({ real: true }); h.detach(); h.binding.attach("editor-return");
    const conflicting: DocumentTemplateBaseline = { ...h.baseline, config: config("saved by someone else"), updatedAt: CONFLICT_AT };
    expect(h.binding.acceptRead({ kind: "authorized", readId: h.binding.beginRead(), baseline: conflicting, editable: true }, documentTemplateDraftFrom(conflicting))).toBe(true);
    const view = h.binding.getSnapshot(); expect(view.mode).toBe("conflict");
    h.binding.discard((view.current ?? view.reference)!.stamp);
    expect(h.binding.getSnapshot().current!.data.config.textBlocks.cert_statement).toBe("saved by someone else");
    expectRebuilt(h, CONFLICT_AT, null);
  });
  it("a logo cleared by the edit read stays cleared", async () => {
    const h = fixture({ real: true, startLogo: "image/png", freshLogo: null }); await editRead(h);
    h.store.discard(h.store.getSnapshot().rows[0].stamps);
    expectRebuilt(h, FRESH_AT, null);
  });
  it("control: with no edit read, the rebuilt copy keeps what the ordinary read brought", () => {
    const h = fixture({ real: true, startLogo: "image/png" });
    h.store.discard(h.store.getSnapshot().rows[0].stamps);
    expectRebuilt(h, READ_AT, "image/png");
  });
});

// Unchanged by #455. The second case pins the outcome only: the store's validity check also
// refuses the copy, so it stays green with the adapter's throw removed.
describe("a discard under a historical baseline seeds no draft", () => {
  const historical = (h: ReturnType<typeof fixture>): DocumentTemplateBaseline => ({ source: "historical", status: "PUBLISHED", templateId: "t", docType: "CERT",
    versionNumber: 1, config: h.baseline.config, updatedAt: FRESH_AT, hasLogo: true, permissions });
  it("the adapter refuses to seed a draft from a historical baseline", () => {
    const h = fixture({ real: true }); const discarded = h.binding.getSnapshot().current!;
    expect(() => documentTemplateRecoveryAdapter.cleanAfterDiscard!({ discarded, clean: documentTemplateDraftFrom(h.baseline), baseline: historical(h) }))
      .toThrow("Discard cannot seed a historical draft.");
  });
  it("discarding the last copy under a historical read builds no draft", () => {
    const h = fixture({ real: true }); h.detach(); h.binding.attach("historical-return");
    expect(h.binding.acceptRead({ kind: "authorized", readId: h.binding.beginRead(), baseline: historical(h), editable: false, recoveryAllowed: false },
      () => { throw new Error("Historical reads must retain an existing copy."); })).toBe(true);
    const retained = h.binding.getSnapshot(); expect(retained.mode).toBe("conflict"); expect(retained.savedBaseline?.source).toBe("historical");
    h.binding.discard(retained.reference!.stamp);
    const after = h.binding.getSnapshot();
    expect(after.mode).toBe("error"); expect(after.current).toBeUndefined(); expect(after.reference).toBeUndefined(); expect(after.savedBaseline).toBeUndefined();
  });
});
