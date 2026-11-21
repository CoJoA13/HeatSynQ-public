import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createDraftStore, type Stamp } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import { CERT_DEFAULT_CONFIG } from "../src/lib/template-contracts";
import { documentTemplateRecoveryAdapter, documentTemplateDraftFrom, readRetainedDocumentTemplate,
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
describe("historical authorization cannot recreate a discarded last copy", () => {
  for (const boundary of ["version GET", "identity"] as const) it(`discard during held ${boundary} refuses read without seeding clean historical data`, async () => {
    const h = fixture(); h.v1.binding.attach("historical-return");
    let releaseVersion!: (value: Awaited<ReturnType<typeof h.readVersion>>) => void;
    let releaseIdentity!: (value: Awaited<ReturnType<typeof h.readIdentity>>) => void;
    const version = new Promise<Awaited<ReturnType<typeof h.readVersion>>>(resolve => { releaseVersion = resolve; });
    const identity = new Promise<Awaited<ReturnType<typeof h.readIdentity>>>(resolve => { releaseIdentity = resolve; });
    const savedVersion = await h.readVersion(); h.readVersion.mockClear();
    if (boundary === "version GET") h.readVersion.mockImplementation(() => version);
    else h.readIdentity.mockImplementation(() => identity);
    const capture = vi.spyOn(h.v1.binding, "capture");
    try {
      const reading = readRetainedDocumentTemplate({ ...h, binding: h.v1.binding, templateId: "t", versionNumber: 1 });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(h.readDetail).toHaveBeenCalledTimes(1); expect(h.readVersion).toHaveBeenCalledTimes(1);
      if (boundary === "identity") expect(h.readIdentity).toHaveBeenCalledTimes(1);
      h.v1.binding.discard(h.v1.stamp);
      expect(h.store.getSnapshot().rows.map(row => row.key.entityVersion)).toEqual(["2"]);
      releaseVersion(savedVersion); releaseIdentity({ id: "u1", permissions });
      expect(await reading).toBe(false);
      const view = h.v1.binding.getSnapshot();
      expect(view.current).toBeUndefined(); expect(view.reference).toBeUndefined(); expect(view.savedBaseline).toBeUndefined(); expect(view.canRestore).toBe(false);
      expect(h.store.getSnapshot().rows.map(row => row.key.entityVersion)).toEqual(["2"]);
      expect(h.v2.binding.getSnapshot().current?.data.config.textBlocks.cert_statement).toBe("v2 separate raw");
      expect(capture).not.toHaveBeenCalled();
    } finally { capture.mockRestore(); }
  });
});
it("an old historical read cannot replace a newer generation or consume a newer version selection", async () => {
  const h = fixture(); h.v1.binding.attach("historical-return");
  let release!: (value: Awaited<ReturnType<typeof h.readIdentity>>) => void;
  const held = new Promise<Awaited<ReturnType<typeof h.readIdentity>>>(resolve => { release = resolve; }); h.readIdentity.mockImplementation(() => held);
  const reading = readRetainedDocumentTemplate({ ...h, binding: h.v1.binding, templateId: "t", versionNumber: 1 });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(h.readVersion).toHaveBeenCalledTimes(1); expect(h.readIdentity).toHaveBeenCalledTimes(1);
  h.v1.binding.discard(h.v1.stamp);
  // Core-generation isolation fixture: a newer authorized ordinary read creates
  // another generation. This does not claim a server can reopen published v1.
  h.v1.binding.acceptRead({ kind: "authorized", readId: h.v1.binding.beginRead(), baseline: h.v1.baseline, editable: true }, documentTemplateDraftFrom(h.v1.baseline));
  h.v1.binding.change(d => ({ ...d, dirty: true, config: config("replacement generation raw") }));
  const replacement = h.v1.binding.getSnapshot().current!;
  expect(replacement.stamp.generation).not.toBe(h.v1.stamp.generation);
  expect(h.session.select(h.v2.key)).toBe(true);
  release({ id: "u1", permissions }); expect(await reading).toBe(false);
  expect(h.v1.binding.getSnapshot().current).toBe(replacement);
  expect(h.v1.binding.getSnapshot().current?.data.config.textBlocks.cert_statement).toBe("replacement generation raw");
  expect(h.v1.binding.getSnapshot().savedBaseline?.source).toBe("open");
  expect(h.store.getSnapshot().rows.map(row => row.key.entityVersion).sort()).toEqual(["1", "2"]);
  expect(h.store.getSnapshot().rows.find(row => row.key.entityVersion === "1")?.stamps).toContainEqual(replacement.stamp);
  expect(h.v2.binding.getSnapshot().current?.stamp).toEqual(h.v2.stamp);
  expect(h.v2.binding.getSnapshot().current?.data.config.textBlocks.cert_statement).toBe("v2 separate raw");
  expect(h.session.consumeSelection(h.v2.key)).toBe(true);
});

// #454 (owner ruling 2026-10-05). A historical view exists only for its retained copy, and its
// loader refuses once that copy is gone. The editor's own Discard then drops the selection; this
// effect does the same when the copy was discarded from the Shell's drafts panel.
describe("the historical view whose retained copy is discarded outside the editor (#454)", () => {
  const source = readFileSync(new URL("../src/app/admin/templates/[id]/edit/TemplateEditor.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("TemplateEditor.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "TemplateEditor")!;
  const sameKey = tree.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText(tree) === "sameKey")!;
  const effects = component.body!.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(tree) === "useEffect" && node.getText(tree).includes("summary.rows"));
  /** The effect as written, with the component's own sameKey; React's setters are supplied. */
  function run(h: ReturnType<typeof fixture>, state: { historical?: boolean; requested?: unknown } = {}) {
    expect(effects, "the effect that reads summary.rows").toHaveLength(1);
    // The dependency list is what makes React run the effect when the panel's discard republishes
    // the store's rows: pin it as written. No browser flow covers the historical view.
    const written = ((effects[0] as ts.ExpressionStatement).expression as ts.CallExpression).arguments[1];
    expect(written && ts.isArrayLiteralExpression(written) ? written.elements.map(element => element.getText(tree)) : null,
      "the effect's dependency list").toEqual(["historical", "slot", "requested", "summary.rows"]);
    const code = ts.transpileModule(`${sameKey.getText(tree)}\n${effects[0].getText(tree)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const setRequested = vi.fn(); let retry = 0;
    let dependencies: unknown;
    const environment = { useEffect: (effect: () => void, given: unknown) => { dependencies = given; effect(); }, historical: true, slot: { key: h.v1.key, binding: h.v1.binding }, requested: h.v1.key,
      summary: h.store.getSnapshot(), setRequested, setRetry: (next: (n: number) => number) => { retry = next(retry); }, ...state };
    new Function(...Object.keys(environment), code)(...Object.values(environment));
    expect(dependencies).toEqual([environment.historical, environment.slot, environment.requested, environment.summary.rows]);
    return { setRequested, retries: () => retry };
  }
  it("drops the selection and reads again once the Shell's panel has discarded the copy", () => {
    const h = fixture(); h.v1.binding.attach("historical-return");
    const kept = run(h);
    expect(kept.setRequested).not.toHaveBeenCalled(); expect(kept.retries()).toBe(0);
    h.store.discard(h.store.getSnapshot().rows.find(row => row.key.entityVersion === "1")!.stamps);
    expect(h.store.getSnapshot().rows.map(row => row.key.entityVersion)).toEqual(["2"]);
    const gone = run(h);
    expect(gone.setRequested).toHaveBeenCalledTimes(1); expect(gone.setRequested).toHaveBeenCalledWith(null);
    expect(gone.retries()).toBe(1);
  });
  it("leaves alone a view that is not the selected historical copy", () => {
    const h = fixture(); h.v1.binding.attach("historical-return");
    h.store.discard(h.store.getSnapshot().rows.find(row => row.key.entityVersion === "1")!.stamps);
    for (const state of [{ historical: false }, { requested: null }, { requested: h.v2.key }]) {
      const other = run(h, state);
      expect(other.setRequested, JSON.stringify(Object.keys(state))).not.toHaveBeenCalled(); expect(other.retries()).toBe(0);
    }
  });
});

// #463 (owner ruling 2026-11-02). A historical row CAN hold two copies: a conflict, Start fresh and
// typing leave the copy that met the conflict and the new one, and the version can then be
// published. When the Shell's drafts panel discards one of the two during the view's read, the read
// takes the row's copies again and restarts once, instead of leaving the view loading.
describe("a historical row with two copies, one discarded during the view's read (#463)", () => {
  function twoCopies() {
    const h = fixture();
    const theirs: DocumentTemplateBaseline = { ...h.v1.baseline, config: config("saved by someone else"), updatedAt: "2026-09-12T00:30:00.000Z" };
    h.v1.binding.attach("v1-return");
    const readId = h.v1.binding.beginRead();
    expect(h.v1.binding.acceptRead({ kind: "authorized", readId, baseline: theirs, editable: true }, documentTemplateDraftFrom(theirs))).toBe(true);
    expect(h.v1.binding.getSnapshot().mode).toBe("conflict");
    expect(h.v1.binding.startFresh(readId, documentTemplateDraftFrom(theirs))).toBe(true);
    h.v1.binding.change(d => ({ ...d, dirty: true, config: config("typed after starting fresh") }));
    const row = () => h.store.getSnapshot().rows.find(r => r.key.entityVersion === "1");
    expect(row()?.stamps).toHaveLength(2);
    return { ...h, row };
  }
  async function readWhileDiscarding(h: ReturnType<typeof twoCopies>, which: (stamps: readonly Stamp[]) => Stamp[]) {
    let release!: (value: { id: string; permissions: string[] }) => void;
    h.readIdentity.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const reading = readRetainedDocumentTemplate({ ...h, binding: h.v1.binding, templateId: "t", versionNumber: 1 });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(h.readIdentity).toHaveBeenCalledTimes(1);
    h.store.discard(which(h.row()!.stamps));
    release({ id: "u1", permissions });
    return reading;
  }
  it("is reachable: the row holds two copies", () => { twoCopies(); });
  it("reads again with the copy that is left, and shows it", async () => {
    const h = twoCopies();
    expect(await readWhileDiscarding(h, stamps => [stamps[1]])).toBe(true);
    expect(h.readDetail).toHaveBeenCalledTimes(2);
    const view = h.v1.binding.getSnapshot();
    expect(view.mode).not.toBe("loading"); expect(view.savedBaseline?.source).toBe("historical");
    expect(h.row()?.stamps).toHaveLength(1);
  });
  it("still ends the read when both copies go", async () => {
    const h = twoCopies();
    expect(await readWhileDiscarding(h, stamps => [...stamps])).toBe(false);
    expect(h.readDetail).toHaveBeenCalledTimes(1); expect(h.row()).toBeUndefined();
  });
});
