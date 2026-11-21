import { describe, expect, it, vi } from "vitest";
import { createDraftSession } from "../src/lib/draft-session";
import { createDraftStore } from "../src/lib/draft-store";
import { CERT_DEFAULT_CONFIG, SHIPPER_DEFAULT_CONFIG, TEMPLATE_DOC_TYPES, TRAVELER_DEFAULT_CONFIG, contractFor, defaultConfigFor, normalizeStoredConfig, validateConfig, type TemplateConfig } from "../src/lib/template-contracts";
import { STALE_DRAFT_MESSAGE, setFieldLabel, setFieldWidth, setLogoPlacement, setLogoWidth } from "../src/lib/template-editor";
import {
  documentTemplateRecoveryAdapter as adapter, documentTemplateBaselineFrom, documentTemplateDraftFrom,
  applyDocumentTemplate, reapplyDocumentTemplate, prepareDocumentTemplate, documentTemplateMetadata, noteDocumentTemplateRejection, readDocumentTemplate,
  type DocumentTemplateBaseline, type DocumentTemplateDetail, type DocumentTemplateDraft, type DocumentTemplateOutcome,
} from "../src/lib/document-template-recovery";
import { seedLiteral } from "./helpers/stored-configs";
import { barcode, layoutOf, standardLayout } from "./helpers/canvas-fixtures";
import type { CanvasItem } from "../src/lib/template-contracts/canvas";

const oldTime = "2026-09-12T00:00:00.000Z";
const newTime = "2026-09-12T01:00:00.000Z";
const config = (text: string): TemplateConfig => ({ ...structuredClone(CERT_DEFAULT_CONFIG), textBlocks: { cert_statement: text } });
const baseline = (text = "saved", versionNumber = 2): DocumentTemplateBaseline => ({ source: "open", status: "DRAFT", templateId: "template-a", docType: "CERT", versionNumber,
  config: config(text), updatedAt: oldTime, logoMimeType: null, permissions: ["templates.view", "templates.edit"] });
function detail(text = "saved", versionNumber = 2): DocumentTemplateDetail {
  return { id: "template-a", name: "Owned certification", docType: "CERT", draft: { versionNumber, config: config(text), updatedAt: oldTime, logoMimeType: null } };
}
function open(saved = baseline()) {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const binding = store.bind({ owner, record: { kind: "document-template", id: "template-a" }, editor: adapter.kind, entityVersion: "2" }, { label: "Template", href: "/admin/templates/template-a/edit" }, adapter);
  const detach = binding.attach("initial"); const readId = binding.beginRead();
  binding.acceptRead({ kind: "authorized", readId, baseline: saved, editable: true }, documentTemplateDraftFrom(saved));
  const edit = (text: string) => binding.change(d => ({ ...d, config: config(text), dirty: true, epoch: d.epoch + 1, stashed: null, conflict: null }));
  const capture = () => { const d = binding.getSnapshot().current!.data; const submission = binding.capture({ config: d.config, updatedAt: d.updatedAt, epoch: d.epoch }, "save-a"); binding.dispatched(submission); return submission; };
  return { binding, store, owner, detach, edit, capture };
}
const rejected = (fresh?: DocumentTemplateBaseline): DocumentTemplateOutcome => ({ kind: "rejected", response: { kind: "conflict", rollback: fresh ? { kind: "authorized", baseline: fresh } : { kind: "failed" } } });
function conflictBaseline(): DocumentTemplateBaseline { return { ...baseline("server after conflict"), updatedAt: newTime }; }

describe("document template recovery, canvas layout", () => {
  it("keeps a canvas layout through capture, rollback copy and the preview, and reads a draft without the key as a flow draft", () => {
    const layout = standardLayout();
    const withLayout = (text: string): TemplateConfig => ({ ...config(text), layout: structuredClone(layout) });
    const h = open();
    h.binding.change(d => ({ ...d, config: withLayout("typed"), dirty: true, epoch: d.epoch + 1, stashed: null, conflict: null }));
    const submission = h.capture();
    expect(submission.payload.config.layout).toEqual(layout);
    h.binding.change(d => ({ ...d, stashed: withLayout("stash") }));
    expect(h.binding.getSnapshot().current!.data.stashed!.layout).toEqual(layout);
    const data = h.binding.getSnapshot().current!.data;
    const lines = adapter.preview!(data, baseline());
    expect(lines).toContainEqual({ label: "Layout", value: `Canvas (${layout.items.length} items)` });
    expect(adapter.preview!({ ...data, config: config("flow") }, baseline())).toContainEqual({ label: "Layout", value: "Sections" });
    const { layout: _dropped, ...old } = withLayout("old");
    void _dropped;
    expect(documentTemplateDraftFrom({ ...baseline(), config: old as TemplateConfig }).config.layout).toBeNull();
    expect(adapter.valid({ ...data, config: old as TemplateConfig }, baseline())).toBe(true);
  });
  for (const later of [false, true]) it(`a seeded layout rides capture, a 409 rollback ${later ? "under a later edit" : "into the stash"} and Restore`, () => {
    // The seed is an ordinary config edit (Task 5): the layout the route answers is applied through
    // `applyDocumentTemplate`, so it rides every path a typed edit does.
    const seeded = standardLayout();
    const h = open();
    h.binding.change(d => applyDocumentTemplate(d, c => ({ ...c, layout: structuredClone(seeded) })));
    expect(h.binding.getSnapshot().current!.data.dirty).toBe(true);
    const submitted = h.capture();
    expect(submitted.payload.config.layout).toEqual(seeded);
    if (later) h.binding.change(d => applyDocumentTemplate(d, c => ({ ...c, textBlocks: { ...c.textBlocks, cert_statement: "later" } })));
    h.binding.settle(submitted, rejected(conflictBaseline()));
    const after = h.binding.getSnapshot().current!.data;
    if (later) { expect(after.config.layout).toEqual(seeded); expect(after.stashed).toBeNull(); }
    else { expect(after.config.layout).toBeNull(); expect(after.stashed!.layout).toEqual(seeded); }
    const stamp = h.binding.getSnapshot().current!.stamp;
    h.detach(); h.binding.attach("return"); expect(h.binding.getSnapshot().current).toBeUndefined();
    const read = h.binding.beginRead();
    h.binding.acceptRead({ kind: "authorized", readId: read, baseline: conflictBaseline(), editable: true }, documentTemplateDraftFrom(conflictBaseline()));
    expect(h.binding.getSnapshot().mode).toBe("offer"); expect(h.binding.restore(stamp, read)).toBe(true);
    const recovered = h.binding.getSnapshot().current!.data;
    expect(recovered.config.layout).toEqual(later ? seeded : null);
    expect(recovered.stashed?.layout ?? null).toEqual(later ? null : seeded);
    if (!later) expect(reapplyDocumentTemplate(recovered).config.layout).toEqual(seeded);
  });
  it("reads a retained draft's layout as valid only when it is none, or version 1 with an items list", () => {
    const h = open();
    const data = h.binding.getSnapshot().current!.data;
    const withLayout = (layout: unknown) => ({ ...data, config: { ...config("typed"), layout } as TemplateConfig });
    // The preview reads `layout.items.length` during render: a draft it cannot read is not valid.
    expect(adapter.valid(withLayout({}), baseline())).toBe(false);
    expect(adapter.valid(withLayout("x"), baseline())).toBe(false);
    expect(adapter.valid(withLayout({ version: 2, items: [] }), baseline())).toBe(false);
    expect(adapter.valid(withLayout({ version: 1, items: {} }), baseline())).toBe(false);
    expect(adapter.valid(withLayout(standardLayout()), baseline())).toBe(true);
    expect(adapter.valid(withLayout(null), baseline())).toBe(true);
    expect(adapter.valid({ ...data, stashed: { ...config("stash"), layout: {} } as TemplateConfig }, baseline())).toBe(false);
  });
});

describe("document template recovery preparation", () => {
  it("projects complete authorized open-version config without logo bytes or unrelated detail cache", () => {
    const input = { ...detail(), logoImage: new Uint8Array([1, 2]), preview: "excluded" };
    const projected = documentTemplateBaselineFrom(input, baseline().permissions);
    expect(projected).not.toBeNull(); expect(projected).toEqual(baseline());
    input.draft!.config.textBlocks.cert_statement = "mutated transport";
    expect(projected!.config.textBlocks.cert_statement).toBe("saved");
    expect(documentTemplateBaselineFrom({ ...detail(), draft: null }, baseline().permissions)).toBeNull();
  });
  it("atomically applies raw config, advances epoch and drops only the superseded stash/banner", () => {
    const current: DocumentTemplateDraft = { ...documentTemplateDraftFrom(baseline()), config: config("working"), dirty: false, epoch: 8, stashed: config("old attempt"), conflict: STALE_DRAFT_MESSAGE };
    const changed = applyDocumentTemplate(current, c => ({ ...c, textBlocks: { ...c.textBlocks, cert_statement: "  raw\nlast event  " } }));
    expect(changed.config.textBlocks.cert_statement).toBe("  raw\nlast event  "); expect(changed.epoch).toBe(9); expect(changed.dirty).toBe(true);
    expect(changed.stashed).toBeNull(); expect(changed.conflict).toBeNull(); expect(current.stashed!.textBlocks.cert_statement).toBe("old attempt");
  });
  for (const stash of [false, true]) it(`recovers complete config/precondition and ${stash ? "clean-working stash" : "dirty work"} only after fresh access`, () => {
    const h = open(); h.binding.change(d => ({ ...d, config: config(stash ? "saved" : "  raw label  "), dirty: !stash, epoch: 7,
      stashed: stash ? config("attempted override") : null, conflict: stash ? STALE_DRAFT_MESSAGE : null }));
    expect(h.store.getSnapshot().count).toBe(1); const stamp = h.binding.getSnapshot().current!.stamp;
    h.detach(); h.binding.attach("return"); expect(h.binding.getSnapshot().current).toBeUndefined(); expect(h.binding.restore(stamp, 1)).toBe(false);
    const read = h.binding.beginRead(); h.binding.acceptRead({ kind: "authorized", readId: read, baseline: baseline(), editable: true }, documentTemplateDraftFrom(baseline()));
    expect(h.binding.getSnapshot().mode).toBe("offer"); expect(h.binding.restore(stamp, read)).toBe(true);
    const recovered = h.binding.getSnapshot().current!.data; expect(recovered.updatedAt).toBe(oldTime); expect(recovered.epoch).toBe(7);
    expect(recovered.config.textBlocks.cert_statement).toBe(stash ? "saved" : "  raw label  ");
    expect(recovered.stashed?.textBlocks.cert_statement ?? null).toBe(stash ? "attempted override" : null);
  });
  for (const changed of ["version", "timestamp", "config", "permission"]) it(`refuses recovery equality for changed ${changed}`, () => {
    const fresh = baseline();
    if (changed === "version") Object.assign(fresh, { versionNumber: 3 });
    if (changed === "timestamp") Object.assign(fresh, { updatedAt: newTime });
    if (changed === "config") fresh.config.textBlocks.cert_statement = "external";
    if (changed === "permission") Object.assign(fresh, { permissions: ["templates.view"] });
    expect(adapter.baselineEqual(baseline(), fresh)).toBe(false);
  });
  it("validates shape without evicting an editable config solely for exceeding width budget", () => {
    const base = baseline(); const over = structuredClone(base.config); for (const section of over.sections) for (const field of section.fields) field.width = 600;
    const data = { ...documentTemplateDraftFrom(base), config: over, dirty: true };
    expect(adapter.valid(data, base)).toBe(true);
    expect(adapter.valid({ ...data, epoch: -1 }, base)).toBe(false);
    expect(adapter.valid({ ...data, stashed: { invalid: true } }, base)).toBe(false);
  });
  it("prepare refuses a layout the validator refuses before capture, and captures one it accepts", () => {
    const saved: DocumentTemplateBaseline = { ...baseline(), docType: "TRAVELER", config: structuredClone(TRAVELER_DEFAULT_CONFIG) };
    const h = open(saved);
    const refused = layoutOf([...standardLayout().items, barcode({ id: "barcode-2", box: { x: 402, y: 600, w: 186, h: 44 } })]);
    h.binding.change(d => ({ ...d, config: { ...d.config, layout: refused }, dirty: true, epoch: d.epoch + 1 }));
    const capture = vi.spyOn(h.binding, "capture");
    try {
      expect(prepareDocumentTemplate(h.binding, "refused-layout")).toBeNull(); expect(capture).not.toHaveBeenCalled();
      expect(h.binding.getSnapshot().current!.data.config.layout).toEqual(refused);
    } finally { capture.mockRestore(); }
    // A retained layout whose item the schema cannot read (no anchor) is refused by the adapter (ruling
    // C34: it parses the layout through the schema, so a restored draft can never throw in the
    // designer). The store refuses a change to such data the same way (it would stand in error, not
    // hold it), so the adapter is asked about the data directly; the same data with a schema-valid
    // layout is accepted, so the refusal is the layout's.
    const anchorless: Partial<CanvasItem> = { ...standardLayout().items[0] };
    delete anchorless.anchor;
    const malformed = layoutOf([...standardLayout().items.slice(1), anchorless as CanvasItem]);
    const held = h.binding.getSnapshot().current!.data;
    expect(adapter.valid({ ...held, config: { ...held.config, layout: malformed } }, saved)).toBe(false);
    expect(adapter.valid({ ...held, config: { ...held.config, layout: standardLayout() } }, saved)).toBe(true);
    h.binding.change(d => ({ ...d, config: { ...d.config, layout: standardLayout() }, dirty: true, epoch: d.epoch + 1 }));
    const submission = prepareDocumentTemplate(h.binding, "accepted-layout");
    expect(submission).not.toBeNull(); expect(submission!.payload.config.layout).toEqual(standardLayout());
  });
  it("refuses width budget before capture and keeps exact raw config", () => {
    const h = open(); const over = config("raw"); for (const section of over.sections) for (const field of section.fields) field.width = 600;
    h.binding.change(d => ({ ...d, config: over, dirty: true })); const capture = vi.spyOn(h.binding, "capture");
    try {
      expect(prepareDocumentTemplate(h.binding, "over-budget")).toBeNull(); expect(capture).not.toHaveBeenCalled(); expect(h.binding.getSnapshot().current!.data.config).toEqual(over);
    } finally { capture.mockRestore(); }
  });
  it("captures the retained server precondition and complete config, not a refreshed timestamp", () => {
    const h = open(); h.edit("attempt"); const submission = prepareDocumentTemplate(h.binding, "explicit");
    expect(submission).not.toBeNull(); expect(submission!.payload.updatedAt).toBe(oldTime); expect(submission!.payload.config.textBlocks.cert_statement).toBe("attempt");
    expect(submission!.payload.epoch).toBe(h.binding.getSnapshot().current!.data.epoch);
  });
  for (const later of [false, true]) it(`raw success advances precondition while ${later ? "preserving later edits" : "clearing submitted dirtiness"}`, () => {
    const h = open(); h.edit("attempt"); const submitted = h.capture(); if (later) h.edit("later");
    h.binding.settle(submitted, { kind: "persisted", response: { kind: "saved", updatedAt: newTime } });
    const after = h.binding.getSnapshot().current!; expect(after.data.updatedAt).toBe(newTime); expect(after.baseline.config.textBlocks.cert_statement).toBe("attempt");
    expect(after.data.config.textBlocks.cert_statement).toBe(later ? "later" : "attempt"); expect(after.data.dirty).toBe(later);
    expect(after.data.stashed).toBeNull(); expect(after.data.conflict).toBeNull();
  });
  for (const later of [false, true]) it(`409 rollback ${later ? "preserves intervening edit and drops obsolete stash" : "keeps clean server working config and attempted stash"}`, () => {
    const h = open(); h.edit("attempt"); const submitted = h.capture(); if (later) h.edit("newer raw config");
    h.binding.settle(submitted, rejected(conflictBaseline()));
    const after = h.binding.getSnapshot().current!; expect(after.data.updatedAt).toBe(newTime);
    expect(after.data.config.textBlocks.cert_statement).toBe(later ? "newer raw config" : "server after conflict");
    expect(after.data.dirty).toBe(later); expect(after.data.stashed?.textBlocks.cert_statement ?? null).toBe(later ? null : "attempt");
    expect(after.data.conflict).toBe(later ? null : STALE_DRAFT_MESSAGE);
  });
  it("failed rollback drops its attempted stash and preserves current work without fabricated acknowledgement", () => {
    const h = open(); h.edit("attempt"); const submitted = h.capture(); h.edit("later"); h.binding.settle(submitted, rejected());
    const after = h.binding.getSnapshot().current!.data; expect(after.config.textBlocks.cert_statement).toBe("later"); expect(after.updatedAt).toBe(oldTime); expect(after.stashed).toBeNull();
  });
  it("reapply uses fresh precondition, clears stash/banner and does not submit", () => {
    const data = { ...documentTemplateDraftFrom(conflictBaseline()), stashed: config("attempt"), conflict: STALE_DRAFT_MESSAGE };
    const next = reapplyDocumentTemplate(data); expect(next.config.textBlocks.cert_statement).toBe("attempt"); expect(next.updatedAt).toBe(newTime); expect(next.dirty).toBe(true);
    expect(next.stashed).toBeNull(); expect(next.conflict).toBeNull();
  });
  for (const later of [false, true]) it(`retains exactly old reference plus ${later ? "later config" : "attempted stash"} after 409`, () => {
    const h = open(); h.edit("old recovery reference"); const fresh = { ...baseline("new working"), updatedAt: newTime };
    const read = h.binding.beginRead(); h.binding.acceptRead({ kind: "authorized", readId: read, baseline: fresh, editable: true }, documentTemplateDraftFrom(fresh));
    expect(h.binding.startFresh(read, documentTemplateDraftFrom(fresh))).toBe(true);
    h.edit("second attempt"); const submitted = h.capture(); if (later) h.edit("third edit, same generation");
    h.binding.settle(submitted, rejected({ ...baseline("rollback server"), updatedAt: "2026-09-12T02:00:00.000Z" }));
    const view = h.binding.getSnapshot(); expect(view.reference!.data.config.textBlocks.cert_statement).toBe("old recovery reference");
    expect(view.current!.data.config.textBlocks.cert_statement).toBe(later ? "third edit, same generation" : "rollback server");
    expect(view.current!.data.stashed?.textBlocks.cert_statement ?? null).toBe(later ? null : "second attempt");
    expect(h.store.getSnapshot().rows).toHaveLength(1); expect(h.store.getSnapshot().rows[0].stamps).toHaveLength(2); expect(view.submitted).toBeUndefined();
  });
  for (const kind of ["persisted", "conflict"] as const) it(`late ${kind} cannot overwrite a generation created after Discard`, () => {
    const h = open(); h.edit("attempt"); const submitted = h.capture(); h.binding.discard(h.binding.getSnapshot().current!.stamp); h.edit("replacement");
    const next = h.binding.getSnapshot().current!.stamp;
    h.binding.settle(submitted, kind === "persisted" ? { kind, response: { kind: "saved", updatedAt: newTime } } : rejected(conflictBaseline()));
    expect(h.binding.getSnapshot().current!.stamp).toEqual(next); expect(h.binding.getSnapshot().current!.data.config.textBlocks.cert_statement).toBe("replacement");
    expect(h.binding.getSnapshot().current!.data.updatedAt).toBe(oldTime);
  });
  it("auth reset prevents an old rollback from recreating its owner's data", () => {
    const h = open(); h.edit("private attempt"); const submitted = h.capture(); h.store.resetIdentity(); h.store.acceptIdentity(h.store.beginIdentityCheck(), "u2");
    h.binding.settle(submitted, rejected(conflictBaseline())); expect(h.binding.getSnapshot().current).toBeUndefined(); expect(h.store.getSnapshot().count).toBe(0);
  });
  it("logo metadata projection updates same-version precondition without adopting config or bytes", () => {
    const base = baseline(); const current = { ...documentTemplateDraftFrom(base), config: config("unsaved"), dirty: true };
    const fresh = { ...baseline(), updatedAt: newTime, logoMimeType: "image/png" };
    const result = documentTemplateMetadata(current, base, fresh);
    if (result === null || result === "changed") throw new Error("expected a projection");
    expect(result.data.config.textBlocks.cert_statement).toBe("unsaved"); expect(result.data.updatedAt).toBe(newTime); expect(result.data.logoMimeType).toBe("image/png");
    expect(result.baseline.config.textBlocks.cert_statement).toBe("saved");
    expect(documentTemplateMetadata(current, base, { ...fresh, versionNumber: 3 })).toBeNull();
    // #460: a server config that is no longer the baseline's is another admin's save: nothing is projected.
    const theirs = { ...baseline("saved by another admin"), updatedAt: newTime, logoMimeType: "image/png" };
    expect(documentTemplateMetadata(current, base, theirs)).toBe("changed");
  });
  // After a save the baseline holds the config this tab sent, while a logo change's read brings the
  // config the server stored and read back. The #460 comparison must find those the same, or every
  // logo change after a save would adopt nothing and the next save would meet an avoidable 409.
  it("a saved config the server validates, stores and reads back compares as unchanged (#460)", () => {
    for (const docType of TEMPLATE_DOC_TYPES) {
      const column = contractFor(docType).sections.flatMap((s) => s.fields.map((f) => ({ s, f }))).find(({ f }) => f.column !== undefined);
      const edits: TemplateConfig[] = [defaultConfigFor(docType)];
      // A contract that withholds the header logo (the container tag) refuses one, so it takes no logo edit.
      if (!contractFor(docType).withholds?.includes("logo")) {
        edits.push(setLogoWidth(setLogoPlacement(defaultConfigFor(docType), "header-left"), 130));
      }
      if (column) {
        const { s, f } = column;
        edits.push(setFieldWidth(setFieldLabel(defaultConfigFor(docType), s.key, f.key, "Renamed"), s.key, f.key, 90));
        edits.push(setFieldWidth(setFieldLabel(setFieldWidth(defaultConfigFor(docType), s.key, f.key, 90), s.key, f.key, ""), s.key, f.key, null));
      }
      for (const sent of edits) {
        const stored = normalizeStoredConfig(docType, JSON.parse(JSON.stringify(validateConfig(docType, sent))));
        const base: DocumentTemplateBaseline = { ...baseline(), docType, config: sent };
        expect(documentTemplateMetadata(documentTemplateDraftFrom(base), base, { ...base, config: stored, updatedAt: newTime }), docType).not.toBe("changed");
      }
    }
  });
  it("records known raw rejection distinctly while rollback is still unresolved", () => {
    const h = open(); h.edit("attempt"); const submitted = h.capture();
    expect(noteDocumentTemplateRejection(h.binding, submitted)).toBe(true);
    // Proposed observational phase distinguishes transport from rollback, without settling
    // the adapter or releasing the captured snapshot before the rollback decision exists.
    const view = h.binding.getSnapshot() as ReturnType<typeof h.binding.getSnapshot> & { submissionPhase?: "transport" | "rollback" };
    expect(view.submissionPhase).toBe("rollback"); expect(view.submitted?.data.config.textBlocks.cert_statement).toBe("attempt");
    h.binding.settle(submitted, rejected()); expect(h.binding.getSnapshot().submitted).toBeUndefined();
  });
  it("return during rejected-save rollback cannot automatically adopt an earlier GET as clean truth", () => {
    const h = open(); h.edit("attempt"); const submitted = h.capture();
    expect(noteDocumentTemplateRejection(h.binding, submitted)).toBe(true);
    h.detach(); h.binding.attach("return"); const read = h.binding.beginRead();
    h.binding.acceptRead({ kind: "authorized", readId: read, baseline: baseline(), editable: true }, documentTemplateDraftFrom(baseline()));
    expect(h.binding.getSnapshot().canRestore).toBe(false); expect(h.binding.getSnapshot().mode).not.toBe("editing");
    h.binding.settle(submitted, rejected(conflictBaseline()));
    expect(h.binding.getSnapshot().current?.data.stashed?.textBlocks.cert_statement).toBe("attempt");
  });
});


describe("document template original read authorization and version", () => {
  function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
  for (const scenario of ["current", "replaced-version", "missing-draft", "no-view", "wrong-owner"] as const) it(`requires actual fresh authorized matching version: ${scenario}`, async () => {
    const h = open(); const session = createDraftSession(h.store); await session.validateIdentity(async () => ({ id: "u1" }));
    const readDetail = vi.fn(async () => scenario === "missing-draft" ? { ...detail(), draft: null } : detail("saved", scenario === "replaced-version" ? 3 : 2));
    const readIdentity = vi.fn(async () => ({ id: scenario === "wrong-owner" ? "u2" : "u1", permissions: scenario === "no-view" ? [] : [...baseline().permissions] }));
    const accepted = vi.fn(); const result = await readDocumentTemplate({ binding: h.binding, session, templateId: "template-a", versionNumber: 2, readDetail, readIdentity, accepted });
    expect(readDetail).toHaveBeenCalledOnce();
    if (scenario === "current") { expect(result).toBe(true); expect(readIdentity).toHaveBeenCalledOnce(); expect(accepted).toHaveBeenCalledOnce(); expect(h.binding.getSnapshot().savedBaseline?.versionNumber).toBe(2); }
    else { expect(result).toBe(false); expect(h.binding.getSnapshot().current).toBeUndefined(); expect(accepted).not.toHaveBeenCalled(); }
  });
  // #676 (2026-10-22 review, G4-4): the detail and identity reads went out one after the other,
  // four serial round trips before the draft opened (discovery's pair, then this read's). Both are
  // sent together now; what counts as fresh is unchanged (both after beginRead, both checked after
  // they land). Mutation: await the detail before sending the identity read and this case reds.
  it("sends the detail and identity reads together, neither waiting on the other's answer", async () => {
    const h = open(); const session = createDraftSession(h.store); await session.validateIdentity(async () => ({ id: "u1" }));
    const detailAnswer = deferred<DocumentTemplateDetail>(); const identityAnswer = deferred<{ id: string; permissions: string[] }>();
    const readDetail = vi.fn(() => detailAnswer.promise); const readIdentity = vi.fn(() => identityAnswer.promise);
    const accepted = vi.fn();
    const read = readDocumentTemplate({ binding: h.binding, session, templateId: "template-a", versionNumber: 2, readDetail, readIdentity, accepted });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(readDetail).toHaveBeenCalledOnce(); expect(readIdentity).toHaveBeenCalledOnce();
    identityAnswer.resolve({ id: "u1", permissions: [...baseline().permissions] }); detailAnswer.resolve(detail());
    expect(await read).toBe(true); expect(accepted).toHaveBeenCalledOnce();
  });
  it("the editor's discovery sends its detail and identity reads together too (#676)", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../src/app/admin/templates/[id]/edit/TemplateEditor.tsx", import.meta.url), "utf8");
    const discovery = text.slice(text.indexOf("const load = async () => {"), text.indexOf("void load(); return () => { live = false; };"));
    expect(discovery).toContain("await Promise.all([");
    expect(discovery).toContain("api<Detail>(`/api/templates/${templateId}`)");
    expect(discovery).toContain('api<{ id: string; permissions: string[] }>("/api/auth/me")');
    expect(discovery).not.toMatch(/const fresh = await api/);
  });
  it("cannot authorize a late same-user pre-check response", async () => {
    const h = open(); const session = createDraftSession(h.store); await session.validateIdentity(async () => ({ id: "u1" }));
    const pending = deferred<DocumentTemplateDetail>(); const accepted = vi.fn(); const read = readDocumentTemplate({ binding: h.binding, session, templateId: "template-a", versionNumber: 2,
      readDetail: () => pending.promise, readIdentity: async () => ({ id: "u1", permissions: [...baseline().permissions] }), accepted });
    await session.validateIdentity(async () => ({ id: "u1" })); pending.resolve(detail()); expect(await read).toBe(false); expect(accepted).not.toHaveBeenCalled();
  });
  it("settlement during held identity phase requires fresh server truth before editable adoption", async () => {
    const h = open(); h.edit("attempt"); const submitted = h.capture(); const session = createDraftSession(h.store);
    const identity = deferred<{ id: string; permissions: string[] }>(); let count = 0;
    const fresh = { ...detail("attempt"), draft: { ...detail("attempt").draft!, updatedAt: newTime } };
    const readDetail = vi.fn(async () => ++count === 1 ? detail() : fresh);
    let identityCount = 0; const readIdentity = vi.fn(async () => ++identityCount === 1 ? identity.promise : { id: "u1", permissions: [...baseline().permissions] });
    const reading = readDocumentTemplate({ binding: h.binding, session, templateId: "template-a", versionNumber: 2, readDetail, readIdentity, accepted: vi.fn() });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    h.binding.settle(submitted, { kind: "persisted", response: { kind: "saved", updatedAt: newTime } });
    identity.resolve({ id: "u1", permissions: [...baseline().permissions] }); await reading;
    expect(readDetail).toHaveBeenCalledTimes(2); expect(readIdentity).toHaveBeenCalledTimes(2);
    expect(h.binding.getSnapshot().current?.data.config.textBlocks.cert_statement).toBe("attempt");
    expect(h.binding.getSnapshot().savedBaseline?.updatedAt).toBe(newTime);
  });
});


describe("proposed opt-in raw rejection phase guards", () => {
  it("marks only an actually dispatched unresolved request and refuses duplicate/final markers", () => {
    const h = open(); h.edit("attempt"); const data = h.binding.getSnapshot().current!.data;
    const queued = h.binding.capture({ config: data.config, updatedAt: data.updatedAt, epoch: data.epoch }, "queued");
    expect(noteDocumentTemplateRejection(h.binding, queued)).toBe(false);
    expect(h.binding.dispatched(queued)).toBe(true); expect(noteDocumentTemplateRejection(h.binding, queued)).toBe(true);
    expect(noteDocumentTemplateRejection(h.binding, queued)).toBe(false);
    const settle = vi.spyOn(adapter, "settle");
    try {
      h.binding.settle(queued, rejected()); h.binding.settle(queued, rejected());
      expect(settle).toHaveBeenCalledTimes(1);
    } finally { settle.mockRestore(); }
    expect(noteDocumentTemplateRejection(h.binding, queued)).toBe(false);
  });
  it("cannot mark another binding or a replacement generation's request", () => {
    const h = open(); h.edit("old"); const submitted = h.capture(); const other = open(); other.edit("other"); const otherSubmitted = other.capture();
    expect(noteDocumentTemplateRejection(other.binding, submitted)).toBe(false);
    expect(noteDocumentTemplateRejection(other.binding, otherSubmitted)).toBe(true);
    h.binding.discard(h.binding.getSnapshot().current!.stamp); h.edit("replacement"); const replacement = h.capture();
    expect(noteDocumentTemplateRejection(h.binding, submitted)).toBe(false);
    expect(noteDocumentTemplateRejection(h.binding, replacement)).toBe(true);
    expect(h.binding.getSnapshot().current!.data.config.textBlocks.cert_statement).toBe("replacement");
  });
  it("cannot mark after auth reset or recreate a hidden old owner's request", () => {
    const h = open(); h.edit("private"); const submitted = h.capture(); h.store.resetIdentity(); h.store.acceptIdentity(h.store.beginIdentityCheck(), "u2");
    expect(noteDocumentTemplateRejection(h.binding, submitted)).toBe(false);
    expect(h.binding.getSnapshot().submitted).toBeUndefined(); expect(h.store.getSnapshot().count).toBe(0);
  });
  it("exposes raw-refused phase before held rollback completes, then settles once", async () => {
    const h = open(); h.edit("attempt"); const submitted = h.capture();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    expect(noteDocumentTemplateRejection(h.binding, submitted)).toBe(true);
    let finalized = false; const rollback = held.then(() => { h.binding.settle(submitted, rejected(conflictBaseline())); finalized = true; });
    await Promise.resolve(); expect(finalized).toBe(false);
    const view = h.binding.getSnapshot() as ReturnType<typeof h.binding.getSnapshot> & { submissionPhase?: "transport" | "rollback" };
    expect(view.submissionPhase).toBe("rollback"); expect(view.submitted?.data.config.textBlocks.cert_statement).toBe("attempt");
    release(); await rollback; expect(finalized).toBe(true); expect(h.binding.getSnapshot().submitted).toBeUndefined();
    expect(h.binding.getSnapshot().current!.data.stashed?.textBlocks.cert_statement).toBe("attempt");
  });
});

describe("the recovery notice names a field by the editor's name for it (the weights design §13.3, ED16)", () => {
  it("lists a traveler draft's four renamed fields under their new names, three lines each", () => {
    const config = structuredClone(TRAVELER_DEFAULT_CONFIG);
    const field = (section: string, key: string) => config.sections.find((s) => s.key === section)!.fields.find((f) => f.key === key)!;
    // One value that is not the default on three of the four, so a line is seen to be its own field's.
    field("lines", "line_weight").label = "Line Wt";
    field("quantities", "container_qty").width = 90;
    field("quantities", "tare_weight").visible = false;
    const saved: DocumentTemplateBaseline = { source: "open", status: "DRAFT", templateId: "template-t", docType: "TRAVELER", versionNumber: 2,
      config, updatedAt: oldTime, logoMimeType: null, permissions: ["templates.view", "templates.edit"] };
    const names = ["Each weight", "Net weight", "Containers", "Tare"];
    const lines = adapter.preview(documentTemplateDraftFrom(saved), saved).filter((line) => names.some((name) => line.label.startsWith(`${name} `)));
    expect(lines).toEqual([
      { label: "Each weight label", value: "Default" }, { label: "Each weight visibility", value: "Shown" }, { label: "Each weight width", value: "Default" },
      { label: "Net weight label", value: "Line Wt" }, { label: "Net weight visibility", value: "Shown" }, { label: "Net weight width", value: "Default" },
      { label: "Containers label", value: "Default" }, { label: "Containers visibility", value: "Shown" }, { label: "Containers width", value: "90" },
      { label: "Tare label", value: "Default" }, { label: "Tare visibility", value: "Hidden" }, { label: "Tare width", value: "Default" },
    ]);
  });
});

describe("the recovery notice names the traveler's last column Order totals (weights design §13.3, ED16)", () => {
  it("builds the recovery notice's three lines for the traveler's last column from Order totals", () => {
    const saved: DocumentTemplateBaseline = { source: "open", status: "DRAFT", templateId: "template-t", docType: "TRAVELER", versionNumber: 2,
      config: structuredClone(TRAVELER_DEFAULT_CONFIG), updatedAt: oldTime, logoMimeType: null, permissions: ["templates.view", "templates.edit"] };
    const lines = adapter.preview(documentTemplateDraftFrom(saved), saved);
    // Every line built from the new name or from the old one: three, and none repeated.
    expect(lines.filter((line) => line.label.startsWith("Order totals ") || line.label.startsWith("Gross weight "))).toEqual([
      { label: "Order totals label", value: "Default" },
      { label: "Order totals visibility", value: "Shown" },
      { label: "Order totals width", value: "Default" },
    ]);
  });
});

describe("a shipping ticket draft (weights design §13.3, ED16; §13.7, point 19)", () => {
  const ticketBaseline = (ticketConfig: TemplateConfig): DocumentTemplateBaseline => ({
    source: "open", status: "DRAFT", templateId: "template-t", docType: "SHIPPER", versionNumber: 2,
    config: ticketConfig, updatedAt: oldTime, logoMimeType: null, permissions: ["templates.view", "templates.edit"] });

  it("lists the notice's lines for Containers and for Totals, with Tare twice and Containers twice", () => {
    const base = ticketBaseline(structuredClone(SHIPPER_DEFAULT_CONFIG));
    const lines = adapter.preview(documentTemplateDraftFrom(base), base).map((line) => `${line.label}: ${line.value}`);
    // Every section is one line and three for each of its fields, in the config's order.
    const of = (key: string) => {
      const at = base.config.sections.findIndex((s) => s.key === key);
      const start = base.config.sections.slice(0, at).reduce((n, s) => n + 1 + 3 * s.fields.length, 0);
      return lines.slice(start, start + 1 + 3 * base.config.sections[at].fields.length);
    };
    const three = (name: string) => [`${name} label: Default`, `${name} visibility: Shown`, `${name} width: Default`];
    expect({ containers: of("containers"), totals: of("totals") }).toEqual({
      containers: ["Containers visibility: Shown", ...three("Container type"), ...three("Containers"),
        ...three("Tare"), ...three("Customer container id")],
      totals: ["Totals visibility: Shown", ...three("Shipped-complete banner"), ...three("Quantity shipped"),
        ...three("Net weight"), ...three("Tare"), ...three("Gross weight")],
    });
  });

  it("a draft kept from before the three fields were added is held as a conflict when the read answers the config with them", () => {
    const before = ticketBaseline(seedLiteral("SHIPPER") as TemplateConfig);
    const after = ticketBaseline(normalizeStoredConfig("SHIPPER", seedLiteral("SHIPPER")));
    const keys = (b: DocumentTemplateBaseline) => b.config.sections.flatMap((s) => s.fields.map((f) => f.key));

    const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
    const binding = store.bind({ owner, record: { kind: "document-template", id: "template-t" }, editor: adapter.kind, entityVersion: "2" },
      { label: "Template", href: "/admin/templates/template-t/edit" }, adapter);
    const detach = binding.attach("initial"); let read = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId: read, baseline: before, editable: true }, documentTemplateDraftFrom(before));
    binding.change((d) => applyDocumentTemplate(d, (c) => ({ ...c, pageFooter: !c.pageFooter })));
    detach(); binding.attach("return"); read = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId: read, baseline: after, editable: true }, documentTemplateDraftFrom(after));
    const view = binding.getSnapshot();
    expect({ gained: keys(after).filter((k) => !keys(before).includes(k)),
      equal: adapter.baselineEqual(before, after), mode: view.mode, canRestore: view.canRestore })
      .toEqual({ gained: ["container_tare", "total_tare", "total_gross"], equal: false, mode: "conflict", canRestore: false });
  });
});
