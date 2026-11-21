import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { createDraftStore } from "../src/lib/draft-store";
import { processStepsRecoveryAdapter, type ProcessStepsBaseline, type ProcessStepsDraft, type ProcessRevision } from "../src/lib/process-steps-recovery";
import { ProcessStepsSection } from "../src/app/parts/[id]/ProcessStepsSection";

// The whole section renders through the hook mocks the catalog-access test established (ruling
// D-1): the header stays inside `ProcessStepsSection`, because the draft-recovery census traces
// every Save and dirty-gated button to a `useRecoverableDraft` binding in the SAME component.
const rendered = vi.hoisted(() => ({ view: null as unknown }));
vi.mock("../src/lib/use-recoverable-draft", async original => ({
  ...await original<typeof import("../src/lib/use-recoverable-draft")>(),
  useDraftIdentity: () => ({ store: null, identityReady: true, owner: { userId: "user", epoch: 1 } }),
  useRecoverableDraft: () => rendered.view,
}));
vi.mock("../src/lib/draft-session", async original => ({
  ...await original<typeof import("../src/lib/draft-session")>(),
  peekBrowserDraftSession: () => null,
}));

const EDITOR = ["parts.view", "processes.view", "processes.edit", "orders.view"];
const VIEWER = ["parts.view", "processes.view"];
const revision = (n: number, lockedAt: string | null): ProcessRevision => ({ revisionNumber: n, lockedAt, steps: [{
  id: `step-${n}`, codeId: "code", position: 1, code: "HT-01", codeName: "Austenitize", instruction: `Instruction ${n}`,
  parameters: [{ key: "temperature", label: "Temperature", type: "NUMBER", unit: "F", position: 0, value: "1550" }],
}] });
type Rev = { n: number; lockedAt?: string | null; orderCount?: number };
/** Revisions newest first, as `getRevisions` answers; the document is always the current one. */
function baselineFor({ revisions, selected, permissions = EDITOR }: { revisions: Rev[]; selected?: number; permissions?: readonly string[] }): ProcessStepsBaseline {
  const sorted = [...revisions].sort((a, b) => b.n - a.n); const highest = sorted[0]?.n ?? null;
  const revs = new Map(sorted.map(r => [r.n, revision(r.n, r.lockedAt ?? null)]));
  const codes = [{ id: "code", code: "HT-01", name: "Austenitize", active: true, fields: [{ id: "temperature", label: "Temperature", type: "NUMBER", unit: "F", sort: 0 }] }];
  return { partId: "part", permissions, highestRevision: highest, selectedRevision: selected ?? highest, codesReady: true,
    summaries: sorted.map(r => ({ revisionNumber: r.n, lockedAt: r.lockedAt ?? null, stepCount: 1, orderCount: r.orderCount ?? 0, createdAt: "2026-09-01" })),
    revisions: revs, codes, document: { revision: highest === null ? null : revs.get(highest)!, baselineToken: "token", codes: codes.map(c => ({ ...c, defaultInstruction: "" })) } };
}
const releases: Array<() => void> = [];
afterEach(() => { for (const release of releases.splice(0)) release(); rendered.view = null; });
/** A real store projects the view the section renders (the catalog-access precedent), so the
 *  read-only, retained-draft and refresh modes are the store's own, never a copied predicate. */
function accept(baseline: ProcessStepsBaseline, editable = baseline.permissions.includes("processes.edit")) {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!;
  const binding = store.bind({ owner, record: { kind: "part", id: "part" }, editor: processStepsRecoveryAdapter.kind }, { label: "Process steps", href: "/parts/part" }, processStepsRecoveryAdapter);
  let detach = binding.attach("section-test"); releases.push(() => detach());
  const clean: ProcessStepsDraft = { selectedRevision: baseline.selectedRevision ?? null, pendingRekey: null };
  const read = () => { const readId = binding.beginRead(); expect(binding.acceptRead({ kind: "authorized", readId, baseline, editable, recoveryAllowed: true }, clean)).toBe(true); };
  read();
  return { binding, revisit: () => { detach(); detach = binding.attach("section-test-return"); read(); } };
}
type RenderOptions = { perms?: readonly string[]; change?: (d: ProcessStepsDraft) => ProcessStepsDraft; revisit?: boolean; unknownSave?: boolean };
function render(baseline: ProcessStepsBaseline, options: RenderOptions = {}) {
  const h = accept(baseline);
  if (options.change) h.binding.change(options.change);
  if (options.revisit) h.revisit();
  if (options.unknownSave) {
    const submitted = h.binding.capture({ kind: "recipe-number", recipeNumber: "0042", expectedRecipeNumber: null }, "unknown-save");
    expect(h.binding.dispatched(submitted)).toBe(true); h.binding.settle(submitted, { kind: "unknown" });
  }
  rendered.view = h.binding.getSnapshot();
  return renderToStaticMarkup(<ProcessStepsSection partId="part" partLabel="AC · P-1" perms={[...(options.perms ?? baseline.permissions)]} />);
}
const button = (html: string, label: string) => { const matches = html.match(new RegExp(`<button\\b[^>]*>${label}</button>`, "g")) ?? []; expect(matches, label).toHaveLength(1); return matches[0]!; };
const byLabel = (html: string, label: string) => { const matches = html.match(new RegExp(`<[a-z]+\\b[^>]*aria-label="${label}"[^>]*>`, "g")) ?? []; expect(matches, label).toHaveLength(1); return matches[0]!; };
const enabled = (element: string) => expect(element).not.toContain('disabled=""');
// The rendered attribute, never the bare word: every control carries `disabled:` Tailwind variants.
const disabledWith = (element: string, title: string) => { expect(element).toContain('disabled=""'); expect(element).toContain(`title="${title}"`); };
const dirtyRows = (d: ProcessStepsDraft): ProcessStepsDraft => ({ ...d, orderedEdits: new Map([[1, [{ clientId: "step-1", stepId: "step-1", codeId: "code", instruction: "Edited instruction",
  parameters: [{ key: "temperature", label: "Temperature", type: "NUMBER", unit: "F", value: "1550" }] }]]]) });

const SECTION = "../src/app/parts/[id]/ProcessStepsSection.tsx";
const sectionSource = ts.createSourceFile(SECTION, readFileSync(new URL(SECTION, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const text = (node: ts.Node) => node.getText(sectionSource).replace(/\s+/g, "");
function nodes<T extends ts.Node>(root: ts.Node, predicate: (n: ts.Node) => n is T): T[] {
  const out: T[] = []; const walk = (n: ts.Node) => { if (predicate(n)) out.push(n); ts.forEachChild(n, walk); }; walk(root); return out;
}

describe("ProcessStepsSection — the header (spec 2026-09-26 §4)", () => {
  it("renders the recipe number and its save, the revision picker with each revision's order count, the status, Discard, Preview traveler and Save process steps; the removed controls are gone", () => {
    const html = render(baselineFor({ revisions: [{ n: 2 }, { n: 1, lockedAt: "2026-09-01", orderCount: 2 }] }));
    expect(html).toMatch(/Recipe number<input\b/); button(html, "Save recipe");
    const picker = html.match(/<select\b[^>]*aria-label="Process revision"[^>]*>.*?<\/select>/)?.[0];
    expect(picker).toBeDefined(); expect(picker).toContain("Rev 2 · on 0 orders"); expect(picker).toContain("Rev 1 · on 2 orders");
    expect(html).toMatch(/<span role="status"[^>]*>Process saved<\/span>/);
    button(html, "Discard process changes"); enabled(button(html, "Preview traveler")); button(html, "Save process steps");
    expect(html).toContain('id="process-steps-table"');
    for (const gone of ["Expand process editor", 'role="tab"', 'id="process-preview-panel"', 'id="process-edit-panel"', "Insert position", "Load template",
      "Locked revision — editing will create a new revision"]) expect(html, gone).not.toContain(gone);
  });
  it("counts one order in the singular", () => {
    const html = render(baselineFor({ revisions: [{ n: 1, lockedAt: "2026-09-01", orderCount: 1 }] }));
    expect(html).toContain("Rev 1 · on 1 order<"); expect(html).not.toContain("on 1 orders");
  });
  it("keeps the revision chip and the recipe identity line", () => {
    const html = render(baselineFor({ revisions: [{ n: 1, lockedAt: "2026-09-01", orderCount: 1 }] }));
    expect(html).toContain("Rev 1 · locked"); expect(html).toContain("AC · P-1 · Recipe unassigned · Revision 1");
  });
});

describe("ProcessStepsSection — the locked-revision note (owner answer D-3, 2026-09-27)", () => {
  // A lock is permanent and the count excludes voided orders, so a locked current revision may be
  // on 0 orders (`revision-cut` locks without one): the note always says a save cuts the next
  // revision, and names the orders that keep this one only when there are any.
  it.each([
    [0, "Saving creates Rev 2."],
    [1, "Saving creates Rev 2. The 1 order on Rev 1 keeps it."],
    [3, "Saving creates Rev 2. The 3 orders on Rev 1 keep it."],
  ])("locked current revision on %i orders", (orderCount, note) => {
    const html = render(baselineFor({ revisions: [{ n: 1, lockedAt: "2026-09-01", orderCount }] }));
    expect(html.match(/Saving creates Rev [^<]*/g)).toEqual([note]);
  });
  it("says nothing about a next revision while the current revision is unlocked, whatever its count", () => {
    expect(render(baselineFor({ revisions: [{ n: 1, orderCount: 2 }] }))).not.toContain("Saving creates");
  });
  it("...nor on a superseded revision, however many orders it carries", () => {
    expect(render(baselineFor({ revisions: [{ n: 2 }, { n: 1, lockedAt: "2026-09-01", orderCount: 4 }], selected: 1 }))).not.toContain("Saving creates");
  });
});

describe("ProcessStepsSection — a superseded revision is read-only", () => {
  it("says so, offers Current revision, and disables the table, Discard, Save and the preview with their reasons", () => {
    const html = render(baselineFor({ revisions: [{ n: 2 }, { n: 1, lockedAt: "2026-09-01", orderCount: 4 }], selected: 1 }));
    expect(html).toContain("Rev 1 is superseded and read-only.");
    enabled(button(html, "Current revision"));
    disabledWith(html.match(/<textarea\b[^>]*>/)![0], "Superseded revision — read-only");
    disabledWith(button(html, "Discard process changes"), "Superseded revision — read-only");
    disabledWith(button(html, "Save process steps"), "Superseded revision — read-only");
    disabledWith(button(html, "Preview traveler"), "Historical revision — select the current revision to preview a local process draft.");
    expect(html).toContain("Instruction 1"); expect(html).not.toContain("Instruction 2");
  });
  it("the current revision offers no way back", () => {
    expect(render(baselineFor({ revisions: [{ n: 2 }, { n: 1 }] }))).not.toContain("Current revision");
  });
});

describe("ProcessStepsSection — permissions (spec §4 Permissions)", () => {
  it("without processes.edit every editing control is disabled with the reason, and Preview traveler stays enabled", () => {
    const html = render(baselineFor({ revisions: [{ n: 1 }], permissions: VIEWER }));
    const reason = "Requires processes.edit";
    for (const element of [
      html.match(/Recipe number<input\b[^>]*>/)![0], button(html, "Save recipe"), button(html, "Discard process changes"), button(html, "Save process steps"),
      html.match(/<textarea\b[^>]*>/)![0], byLabel(html, "Insert a step above step 1"), byLabel(html, "Add a parameter to step 1"), byLabel(html, "Move step 1"),
      byLabel(html, "Step 1 actions"), byLabel(html, "Step 1 Temperature"), byLabel(html, "Add a step — search code or name"),
    ]) disabledWith(element, reason);
    enabled(button(html, "Preview traveler"));
  });
  it("without processes.view the section shows only its frame and the missing permission", () => {
    const html = render(baselineFor({ revisions: [{ n: 1 }] }), { perms: ["parts.view"] });
    expect(html).toContain("Process steps need processes.view access."); expect(html).toContain("<h2");
    for (const gone of ["Save process steps", "Discard process changes", "Preview traveler", "<table", "Recipe number<input", 'aria-label="Process revision"', "<dialog"]) expect(html, gone).not.toContain(gone);
  });
  it("...and issues no recovery read at all (the read would only 403); an undecided page still reads", () => {
    const effects = nodes(sectionSource, ts.isCallExpression).filter(c => text(c.expression) === "useEffect");
    const found = effects.filter(e => e.arguments[1] && text(e.arguments[1]) === "[load,authorizationRevision,noView]");
    expect(found, "the load effect keyed on noView").toHaveLength(1);
    for (const [noView, calls] of [[true, 0], [false, 1]] as const) {
      const load = vi.fn(async () => true);
      bind<() => void>(found[0].arguments[0], { noView, load })();
      expect(load, `noView=${noView}`).toHaveBeenCalledTimes(calls);
    }
  });
  it("Preview traveler is disabled with its reason while retained work awaits Restore, and while the last save's outcome is unknown", () => {
    const retained = render(baselineFor({ revisions: [{ n: 1 }] }), { change: dirtyRows, revisit: true });
    disabledWith(button(retained, "Preview traveler"), "Resolve retained process work before previewing.");
    disabledWith(button(retained, "Discard process changes"), "Resolve retained steps and confirm current access before editing.");
    const unknown = render(baselineFor({ revisions: [{ n: 1 }] }), { unknownSave: true });
    disabledWith(button(unknown, "Preview traveler"), "Resolve retained process work before previewing.");
    disabledWith(button(unknown, "Discard process changes"), "Resolve retained steps and confirm current access before editing.");
    expect(unknown).toContain("Saved state needs refresh");
  });
  // #657: while the section's own refresh after a landed save is out, the status says so; the
  // "needs refresh" wording stays for a failed refresh or an unknown outcome (above).
  it("says Saved — refreshing… while the post-save refresh is out, from the section's own flag", () => {
    const text = readFileSync(fileURLToPath(new URL("../src/app/parts/[id]/ProcessStepsSection.tsx", import.meta.url)), "utf8");
    expect(text).toContain('refreshing ? "Saved — refreshing…" : view.needsRefresh ? "Saved state needs refresh"');
    expect(text).toMatch(/setRefreshing\(true\)[\s\S]*await load\([\s\S]*setRefreshing\(false\)/);
  });
});

// ------------------------------------------------------------------------------------------------
// Discard: a section-owned button (ruling D-2 + #309). The shared `DiscardButton` hides while clean
// and ignores permissions, which the disabled-not-hidden rule forbids here.
// ------------------------------------------------------------------------------------------------
/** A node's source, its free identifiers bound to `environment` — the `task-8-callbacks`
 *  technique, so the executed body is the real one. */
function bind<T>(node: ts.Node, environment: Record<string, unknown>): T {
  const code = ts.transpileModule(`return (${node.getText(sectionSource)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T;
}
/** One named function or declaration from the section. */
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let found: ts.FunctionDeclaration | ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(sectionSource) === name && node.initializer) {
      found = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(sectionSource); expect(found, `actual ${name}`).toBeDefined();
  return bind<T>(found!, environment);
}

describe("ProcessStepsSection — Discard (ruling D-2, #309)", () => {
  it("is disabled with No unsaved changes while clean, and enabled once rows or the recipe number differ from the saved baseline", () => {
    const clean = render(baselineFor({ revisions: [{ n: 1 }] }));
    disabledWith(button(clean, "Discard process changes"), "No unsaved changes"); disabledWith(button(clean, "Save process steps"), "No unsaved changes");
    const rows = render(baselineFor({ revisions: [{ n: 1 }] }), { change: dirtyRows });
    enabled(button(rows, "Discard process changes")); enabled(button(rows, "Save process steps")); expect(rows).toContain("Unsaved process changes");
    const number = render(baselineFor({ revisions: [{ n: 1 }] }), { change: d => ({ ...d, recipeNumberEdit: "0042" }) });
    enabled(button(number, "Discard process changes")); enabled(button(number, "Save recipe"));
  });
  it("one click empties every ordered draft and the recipe-number edit, clears the Undo offer, the open insert position and the failed-save status; disabled, it does nothing", () => {
    const env = { discardDisabled: false, binding: { change: vi.fn() }, clearUndo: vi.fn(), setInsertAt: vi.fn(), setSaveError: vi.fn() };
    actual<() => void>("discardAction", env)();
    expect(env.binding.change).toHaveBeenCalledTimes(1);
    const reduce = env.binding.change.mock.calls[0][0] as (d: ProcessStepsDraft) => ProcessStepsDraft;
    const before: ProcessStepsDraft = { selectedRevision: 1, pendingRekey: null, recipeNumberEdit: "0042", orderedEdits: new Map([[1, []], [2, []]]) };
    expect(reduce(before)).toEqual({ selectedRevision: 1, pendingRekey: null, recipeNumberEdit: undefined, orderedEdits: new Map() });
    expect(env.clearUndo).toHaveBeenCalledTimes(1); expect(env.setInsertAt).toHaveBeenCalledWith(null); expect(env.setSaveError).toHaveBeenCalledWith(null);
    const refused = { discardDisabled: true, binding: { change: vi.fn() }, clearUndo: vi.fn(), setInsertAt: vi.fn(), setSaveError: vi.fn() };
    actual<() => void>("discardAction", refused)();
    expect(refused.binding.change).not.toHaveBeenCalled(); expect(refused.clearUndo).not.toHaveBeenCalled(); expect(refused.setInsertAt).not.toHaveBeenCalled();
  });
  it("its reason: the row reason first, then a save in flight (it cannot unsend a request), then nothing to discard", () => {
    const title = (env: Record<string, unknown>) => actual<string | undefined>("discardTitle",
      { rowDisabled: false, rowTitle: undefined, pending: false, sectionDirty: true, DISCARD_PENDING_REASON: "pending-reason", ...env });
    expect(title({ rowDisabled: true, rowTitle: "Requires processes.edit" })).toBe("Requires processes.edit");
    expect(title({ rowDisabled: true, rowTitle: "Requires processes.edit", pending: true })).toBe("Requires processes.edit");
    expect(title({ pending: true })).toBe("pending-reason");
    expect(title({ pending: true, sectionDirty: false })).toBe("pending-reason");
    expect(title({ sectionDirty: false })).toBe("No unsaved changes");
    expect(title({})).toBeUndefined();
    expect(sectionSource.text).toContain('const DISCARD_PENDING_REASON = "Saving — Discard is unavailable until the save settles."');
  });
  it("the button reads the reason it computes, and the section registers the same dirtiness with the unsaved-edit guard", () => {
    const text = (node: ts.Node) => node.getText(sectionSource).replace(/\s+/g, "");
    const elements: ts.JsxOpeningElement[] = [];
    const walk = (n: ts.Node) => { if (ts.isJsxOpeningElement(n)) elements.push(n); ts.forEachChild(n, walk); }; walk(sectionSource);
    const discard = elements.find(e => ts.isJsxElement(e.parent) && e.parent.children.some(c => ts.isJsxText(c) && c.text.trim() === "Discard process changes"));
    expect(discard, "the Discard button").toBeDefined();
    const attr = (name: string) => discard!.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(sectionSource) === name);
    expect(text(attr("disabled")!)).toBe("disabled={discardDisabled}"); expect(text(attr("title")!)).toBe("title={discardTitle}"); expect(text(attr("onClick")!)).toBe("onClick={discardAction}");
    expect(sectionSource.text).toContain('useUnsavedSection(sectionDirty, "Process steps")');
  });
});
