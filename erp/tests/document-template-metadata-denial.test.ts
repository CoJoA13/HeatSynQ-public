import { describe, expect, it, vi } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import { CERT_DEFAULT_CONFIG } from "../src/lib/template-contracts";
import { documentTemplateRecoveryAdapter, documentTemplateDraftFrom, readDocumentTemplateMetadata,
  type DocumentTemplateBaseline, type DocumentTemplateDetail } from "../src/lib/document-template-recovery";
const permissions = ["templates.view", "templates.edit"];
const config = (text: string) => ({ ...structuredClone(CERT_DEFAULT_CONFIG), textBlocks: { cert_statement: text } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture() {
  const store = createDraftStore(); const session = createDraftSession(store); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const adapter = { ...documentTemplateRecoveryAdapter, allowEditRead: true, valid: () => true,
    dirty: (d: ReturnType<typeof documentTemplateDraftFrom>) => d.dirty, baselineEqual: (a: DocumentTemplateBaseline, b: DocumentTemplateBaseline) => JSON.stringify(a) === JSON.stringify(b) };
  const binding = store.bind({ owner, record: { kind: "document-template", id: "t" }, editor: adapter.kind, entityVersion: "1" }, { label: "Template", href: "/admin/templates/t/edit" }, adapter);
  const detach = binding.attach("editor");
  const baseline: DocumentTemplateBaseline = { source: "open", status: "DRAFT", templateId: "t", docType: "CERT", versionNumber: 1,
    config: config("OLD saved config"), updatedAt: "2026-09-12T00:00:00.000Z", logoMimeType: null, permissions };
  binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline, editable: true }, documentTemplateDraftFrom(baseline));
  const edit = (text: string) => binding.change(d => ({ ...d, dirty: true, epoch: d.epoch + 1, config: config(text) }));
  edit("initial raw"); const expectedStamp = binding.getSnapshot().current!.stamp;
  const fresh: DocumentTemplateDetail = { id: "t", docType: "CERT", name: "Owned", draft: { versionNumber: 1,
    config: config("OLD saved config"), updatedAt: "2026-09-12T01:00:00.000Z", logoMimeType: "image/png" } }; // only the logo moved (#460)
  const readDetail = vi.fn(async () => fresh); const readIdentity = vi.fn(async () => ({ id: "u1", permissions }));
  const args = { binding, session, expectedStamp, readDetail, readIdentity };
  return { store, session, binding, detach, edit, fresh, args, readDetail, readIdentity };
}
describe("fresh metadata authorization refusal closes only its original edit-read access", () => {
  for (const denial of ["view", "edit", "owner", "GET failure", "missing draft", "invalid config"] as const) it(`fresh ${denial} refusal blocks writes while retaining exact raw work`, async () => {
    const h = fixture(); const before = h.binding.getSnapshot().current!;
    h.readIdentity.mockResolvedValue({ id: denial === "owner" ? "u2" : "u1", permissions: denial === "view" ? ["templates.edit"] : denial === "edit" ? ["templates.view"] : permissions });
    if (denial === "GET failure") h.readDetail.mockRejectedValue({ status: 503 });
    if (denial === "missing draft") h.readDetail.mockResolvedValue({ ...h.fresh, draft: null });
    if (denial === "invalid config") h.readDetail.mockResolvedValue({ ...h.fresh, draft: { ...h.fresh.draft!, config: { ...h.fresh.draft!.config, sections: undefined as never } } });
    expect(await readDocumentTemplateMetadata(h.args)).toBe(false);
    expect(h.readDetail).toHaveBeenCalledTimes(1); expect(h.readIdentity).toHaveBeenCalledTimes(denial === "GET failure" ? 0 : 1);
    expect(h.binding.getSnapshot().mode).toBe("unavailable");
    expect(h.binding.getSnapshot().current).toBeUndefined(); expect(h.binding.getSnapshot().reference).toBeUndefined();
    expect(h.binding.getSnapshot().canRestore).toBe(false);
    expect(h.store.getSnapshot().count).toBe(1); expect(h.store.getSnapshot().rows[0].stamps).toContainEqual(before.stamp);
    expect(() => h.binding.capture({ config: before.data.config, updatedAt: before.data.updatedAt, epoch: before.data.epoch }, "denied-save")).toThrow();
    h.binding.change(d => ({ ...d, config: config("must not land") }));
    const baseline = before.baseline;
    h.binding.acceptRead({ kind: "authorized", readId: h.binding.beginRead(), baseline, editable: true }, documentTemplateDraftFrom(baseline));
    expect(h.binding.getSnapshot().current?.data).toEqual(before.data);
    expect(h.binding.getSnapshot().current?.stamp.generation).toBe(before.stamp.generation);
  });
  for (const later of ["read", "lease", "generation"] as const) it(`stale denied metadata cannot close a newer authorized ${later}`, async () => {
    const h = fixture(); const held = deferred<{ id: string; permissions: string[] }>(); h.readIdentity.mockImplementation(() => held.promise);
    const baseline = h.binding.getSnapshot().current!.baseline;
    const reading = readDocumentTemplateMetadata(h.args); await tick(); expect(h.readIdentity).toHaveBeenCalledTimes(1);
    if (later === "lease") { h.detach(); h.binding.attach("new-lease"); }
    if (later === "generation") h.binding.discard(h.binding.getSnapshot().current!.stamp);
    const readId = h.binding.beginRead();
    h.binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, documentTemplateDraftFrom(baseline));
    if (h.binding.getSnapshot().canRestore) h.binding.restore(h.binding.getSnapshot().current!.stamp, readId);
    // A fresh read alone need not Restore retained work. Pin its exact authorized
    // view: stale metadata may neither hide it nor change its current generation.
    const authorized = h.binding.getSnapshot();
    held.resolve({ id: "u1", permissions: [] }); expect(await reading).toBe(false);
    expect(h.binding.getSnapshot()).toBe(authorized);
    expect(h.binding.getSnapshot().mode).not.toBe("unavailable");
  });
});

it("obsolete mismatched-version completion cannot close a newer accepted read", async () => {
  const h = fixture(); const baseline = h.binding.getSnapshot().current!.baseline; const held = deferred<DocumentTemplateDetail>();
  h.readDetail.mockImplementation(() => held.promise);
  const reading = readDocumentTemplateMetadata(h.args); await tick(); expect(h.readDetail).toHaveBeenCalledTimes(1);
  h.binding.acceptRead({ kind: "authorized", readId: h.binding.beginRead(), baseline, editable: true }, documentTemplateDraftFrom(baseline));
  const newer = h.binding.getSnapshot();
  held.resolve({ ...h.fresh, draft: { ...h.fresh.draft!, versionNumber: 2 } }); expect(await reading).toBe(false);
  expect(h.binding.getSnapshot()).toBe(newer); expect(h.binding.getSnapshot().mode).not.toBe("unavailable");
});
