import { describe, expect, it, vi } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import { CERT_DEFAULT_CONFIG } from "../src/lib/template-contracts";
import { documentTemplateRecoveryAdapter, documentTemplateDraftFrom, consumeDocumentTemplateSelection, readRetainedDocumentTemplate,
  type DocumentTemplateBaseline } from "../src/lib/document-template-recovery";
const permissions = ["templates.view", "templates.edit"];
const config = (text: string) => ({ ...structuredClone(CERT_DEFAULT_CONFIG), textBlocks: { cert_statement: text } });
function fixture() {
  const store = createDraftStore(); const session = createDraftSession(store); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const adapter = { ...documentTemplateRecoveryAdapter, valid: () => true, dirty: (data: ReturnType<typeof documentTemplateDraftFrom>) => data.dirty,
    baselineEqual: (a: DocumentTemplateBaseline, b: DocumentTemplateBaseline) => JSON.stringify(a) === JSON.stringify(b) };
  const version = (n: number) => {
    const key = { owner, record: { kind: "document-template", id: "t" }, editor: adapter.kind, entityVersion: String(n) };
    const binding = store.bind(key, { label: "Template", href: "/admin/templates/t/edit" }, adapter); const detach = binding.attach(`v${n}`);
    const baseline: DocumentTemplateBaseline = { source: "open", status: "DRAFT", templateId: "t", docType: "CERT", versionNumber: n,
      config: config(`saved v${n}`), updatedAt: "2026-09-12T00:00:00.000Z", logoMimeType: null, permissions };
    binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline, editable: true }, documentTemplateDraftFrom(baseline));
    binding.change(d => ({ ...d, dirty: true, config: config(n === 1 ? "  v1 raw\nlast event  " : "v2 separate raw") }));
    return { key, binding, detach, baseline, stamp: binding.getSnapshot().current!.stamp };
  };
  const v1 = version(1); v1.detach(); const v2 = version(2);
  const readDetail = vi.fn(async () => ({ id: "t", docType: "CERT" as const, name: "Owned",
    draft: { versionNumber: 2, config: config("saved v2"), updatedAt: "2026-09-12T01:00:00.000Z", logoMimeType: null },
    versions: [{ versionNumber: 2, status: "DRAFT" as const }, { versionNumber: 1, status: "PUBLISHED" as const }] }));
  const readVersion = vi.fn(async () => ({ versionNumber: 1, status: "PUBLISHED" as const, config: config("saved v1"), updatedAt: "2026-09-12T01:00:00.000Z", hasLogo: true }));
  const readIdentity = vi.fn(async () => ({ id: "u1", permissions }));
  return { store, session, v1, v2, readDetail, readVersion, readIdentity };
}
describe("retained document-template version selection proposal", () => {
  it("switches exact real-session versions and exposes only authorized v1 raw preview without Restore or capture", async () => {
    const h = fixture(); const capture1 = vi.spyOn(h.v1.binding, "capture"); const capture2 = vi.spyOn(h.v2.binding, "capture");
    try {
      expect(h.store.getSnapshot().rows.map(row => row.key.entityVersion).sort()).toEqual(["1", "2"]);
      expect(h.session.select(h.v1.key)).toBe(true);
      expect(consumeDocumentTemplateSelection(h.session, "t")).toEqual(h.v1.key);
      expect(consumeDocumentTemplateSelection(h.session, "t")).toBeNull();
      h.v2.detach(); h.v1.binding.attach("selected-v1");
      expect(h.v1.binding.getSnapshot().reference).toBeUndefined();
      expect(await readRetainedDocumentTemplate({ ...h, binding: h.v1.binding, templateId: "t", versionNumber: 1 })).toBe(true);
      const view = h.v1.binding.getSnapshot();
      expect(view.canRestore).toBe(false); expect(view.mode).toBe("conflict");
      expect(view.reference?.stamp).toEqual(h.v1.stamp);
      expect(view.reference?.data.config.textBlocks.cert_statement).toBe("  v1 raw\nlast event  ");
      expect(view.savedBaseline).toEqual(expect.objectContaining({ source: "historical", versionNumber: 1, hasLogo: true }));
      expect(view.savedBaseline).not.toHaveProperty("logoMimeType");
      expect(view.savedBaseline?.config.textBlocks.cert_statement).toBe("saved v1");
      expect(h.readDetail).toHaveBeenCalledTimes(1); expect(h.readVersion).toHaveBeenCalledTimes(1); expect(h.readIdentity).toHaveBeenCalledTimes(1);
      expect(h.session.select(h.v2.key)).toBe(true); expect(consumeDocumentTemplateSelection(h.session, "t")).toEqual(h.v2.key);
      h.v2.binding.attach("selected-v2");
      h.v2.binding.acceptRead({ kind: "authorized", readId: h.v2.binding.beginRead(), baseline: h.v2.baseline, editable: true }, documentTemplateDraftFrom(h.v2.baseline));
      expect(h.v2.binding.getSnapshot().current?.stamp).toEqual(h.v2.stamp);
      expect(h.v2.binding.getSnapshot().current?.data.config.textBlocks.cert_statement).toBe("v2 separate raw");
      expect(h.v1.binding.getSnapshot().reference?.data.config.textBlocks.cert_statement).toBe("  v1 raw\nlast event  ");
      expect(capture1).not.toHaveBeenCalled(); expect(capture2).not.toHaveBeenCalled();
    } finally { capture1.mockRestore(); capture2.mockRestore(); }
  });
  it("does not consume another template selection", () => {
    const h = fixture(); h.session.select(h.v1.key);
    expect(consumeDocumentTemplateSelection(h.session, "other")).toBeNull();
    expect(h.session.consumeSelection(h.v1.key)).toBe(true);
  });
  it("a historical identity response held across same-user revalidation cannot expose raw values", async () => {
    const h = fixture(); h.v1.binding.attach("selected"); let release!: (value: { id: string; permissions: string[] }) => void;
    const held = new Promise<{ id: string; permissions: string[] }>(resolve => { release = resolve; });
    h.readIdentity.mockImplementation(() => held);
    const running = readRetainedDocumentTemplate({ ...h, binding: h.v1.binding, templateId: "t", versionNumber: 1 });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(h.readVersion).toHaveBeenCalledTimes(1); expect(h.readIdentity).toHaveBeenCalledTimes(1);
    await h.session.validateIdentity(async () => ({ id: "u1" })); release({ id: "u1", permissions });
    expect(await running).toBe(false); expect(h.v1.binding.getSnapshot().reference).toBeUndefined(); expect(h.v1.binding.getSnapshot().current).toBeUndefined();
  });
});
