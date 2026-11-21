import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDraftStore } from "../src/lib/draft-store";
import { processStepsRecoveryAdapter, type ProcessStepsBaseline, type ProcessStepsDraft, type ProcessRevision } from "../src/lib/process-steps-recovery";
import { ProcessStepsSection } from "../src/app/parts/[id]/ProcessStepsSection";

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
const releaseViews: Array<() => void> = [];
afterEach(() => { for (const release of releaseViews.splice(0)) release(); vi.restoreAllMocks(); rendered.view = null; });
const permissions = ["parts.view", "processes.view", "processes.edit"];
function render() {
  return renderToStaticMarkup(<ProcessStepsSection partId="part" perms={permissions} />);
}
it("offers no process template picker to an authorized editor (spec 2026-09-26 §3.6)", () => {
  const baseline = { partId: "part", permissions, highestRevision: null, selectedRevision: null,
    summaries: [], revisions: new Map(), codes: [], codesReady: true };
  rendered.view = { mode: "editing", canRestore: false, needsRefresh: false, savedBaseline: baseline,
    current: { stamp: permissionFixture(permissions).binding.getSnapshot().current!.stamp, data: { selectedRevision: null, pendingRekey: null }, baseline } };
  const html = render();
  expect(html).toContain("Save process steps");
  expect(html).not.toContain("Load template");
  expect(html).not.toContain('aria-label="Process template"');
});


// Real accepted store projections drive the actual component; no copied title predicate.
function permissionFixture(grants: readonly string[], superseded = false) {
  const revision: ProcessRevision = { revisionNumber: 1, lockedAt: null, steps: [{
    id: "step", codeId: "code", position: 1, code: "C", codeName: "Code", instruction: "Saved instruction",
    parameters: [{ key: "temperature", label: "Temperature", type: "NUMBER", unit: "F", position: 0, value: "500" }],
  }] };
  const baseline: ProcessStepsBaseline = { partId: "part", permissions: grants, highestRevision: superseded ? 2 : 1,
    selectedRevision: 1, codesReady: true,
    summaries: [{ revisionNumber: 1, lockedAt: null, stepCount: 1, orderCount: 0, createdAt: "2026-09-01" }],
    revisions: new Map([[1, revision]]),
    codes: [{ id: "code", code: "C", name: "Code", active: true,
      fields: [{ id: "temperature", label: "Temperature", type: "NUMBER", unit: "F", sort: 0 }] }],
  };
  const fresh: ProcessStepsBaseline = superseded ? { ...baseline,
    summaries: [{ revisionNumber: 2, lockedAt: null, stepCount: 1, orderCount: 0, createdAt: "2026-09-02" }, ...baseline.summaries],
    revisions: new Map<number, ProcessRevision>([...baseline.revisions, [2, { ...revision, revisionNumber: 2,
      steps: revision.steps.map(step => ({ ...step, id: "new-step" })) }]]),
  } : baseline;
  const clean: ProcessStepsDraft = { selectedRevision: 1, pendingRekey: null };
  const store = createDraftStore();
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!;
  const binding = store.bind({ owner, record: { kind: "part", id: "part" }, editor: processStepsRecoveryAdapter.kind },
    { label: "Process steps", href: "/parts/part" }, processStepsRecoveryAdapter);
  let detach = binding.attach("permission-test-first"); releaseViews.push(() => detach());
  const read = () => {
    const readId = binding.beginRead();
    expect(binding.acceptRead({ kind: "authorized", readId, baseline: fresh, editable: grants.includes("processes.edit"), recoveryAllowed: true }, clean)).toBe(true);
  };
  read();
  return { store, binding, read, revisit: () => { detach(); detach = binding.attach("permission-test-return"); read(); } };
}
function expectDisabledStepControls(html: string, title: string) {
  const instruction = html.match(/<textarea\b[^>]*placeholder="Instruction"[^>]*>/g) ?? [];
  const saves = html.match(/<button\b[^>]*>Save process steps<\/button>/g) ?? [];
  expect(instruction).toHaveLength(1); expect(saves).toHaveLength(1);
  for (const control of [...instruction, ...saves]) {
    expect(control).toContain('disabled=""'); expect(control).toContain(`title="${title}"`);
  }
}
it("keeps the exact denied permission reason from accepted readonly access despite stale granted props", () => {
  const h = permissionFixture(["parts.view", "processes.view"]);
  const view = h.binding.getSnapshot();
  expect(view.mode).toBe("conflict"); expect(view.current).toBeUndefined(); expect(view.reference).toBeUndefined();
  expect(view.savedBaseline?.permissions).not.toContain("processes.edit"); expect(h.store.getSnapshot().count).toBe(0);
  rendered.view = view; // render() intentionally still passes the original fully granted props.
  const html = render();
  expect(html).toContain("Saved instruction"); expect(html).toContain('value="500"');
  expectDisabledStepControls(html, "Requires processes.edit");
  const temperature = html.match(/<input\b[^>]*inputMode="decimal"[^>]*>/g) ?? [];
  expect(temperature).toHaveLength(1); expect(temperature[0]).toContain('disabled=""');
  expect(temperature[0]).toContain('title="Requires processes.edit"');
});
it("does not turn granted permission into editable controls while retained work awaits Restore", () => {
  const h = permissionFixture(permissions);
  h.binding.change(d => ({ ...d, orderedEdits: new Map([[1, [{ clientId: "step", stepId: "step", codeId: "code", instruction: "Retained raw instruction", parameters: [{ key: "temperature", label: "Temperature", type: "NUMBER", unit: "F", value: "500" }] }]]]) }));
  h.revisit(); const view = h.binding.getSnapshot(); expect(view.mode).toBe("offer"); expect(view.canRestore).toBe(true);
  rendered.view = view;
  expectDisabledStepControls(render(), "Resolve retained steps and confirm current access before editing.");
});
it("keeps the recovery reason while permitted work requires a fresh read after an unknown outcome", () => {
  const h = permissionFixture(permissions);
  const submitted = h.binding.capture({ kind: "recipe-number", recipeNumber: "001", expectedRecipeNumber: null }, "unknown-recipe-number");
  expect(h.binding.dispatched(submitted)).toBe(true); h.binding.settle(submitted, { kind: "unknown" });
  const view = h.binding.getSnapshot(); expect(view.needsRefresh).toBe(true);
  expect(view.savedBaseline?.permissions).toContain("processes.edit"); rendered.view = view;
  expectDisabledStepControls(render(), "Resolve retained steps and confirm current access before editing.");
});
it("preserves the superseded revision reason over missing edit permission", () => {
  const h = permissionFixture(["parts.view", "processes.view"], true);
  const view = h.binding.getSnapshot(); expect(view.savedBaseline?.selectedRevision).toBe(1);
  expect(view.savedBaseline?.highestRevision).toBe(2); rendered.view = view;
  expectDisabledStepControls(render(), "Superseded revision — read-only");
});

it("renders a locked numbered revision's own rows, never the live suggestion's label (spec 2026-09-26 §8)", () => {
  // The rows' labels are the part's; the snapshot rides along for display and the catalog's
  // renamed suggestion reaches neither the label nor the value.
  const r: ProcessRevision = { revisionNumber: 1, lockedAt: "2026-09-19", recipeNumber: "001207", steps: [{
    id: "step", codeId: "code", position: 1, code: "CAP", codeName: "Captured code", instruction: "Captured instruction",
    parameters: [{ key: "temperature", label: "Part temperature", type: "NUMBER", unit: "F", position: 0, value: "1550" }],
  }], recipeSnapshot: { schemaVersion: 1, recipeId: "recipe", recipeNumber: "001207", partId: "part", revisionNumber: 1,
    steps: [{ stepId: "step", codeId: "code", position: 1, code: "CAP", codeName: "Captured code", instruction: "Captured instruction",
      fields: [{ fieldDefId: "temperature", label: "Captured temperature", type: "NUMBER", unit: "F", position: 0, value: "1550" }] }] } };
  const b: ProcessStepsBaseline = { partId: "part", permissions, highestRevision: 1, selectedRevision: 1, codesReady: true,
    summaries: [{ revisionNumber: 1, recipeNumber: "001207", lockedAt: "2026-09-19", stepCount: 1, orderCount: 0, createdAt: "2026-09-19" }], revisions: new Map([[1, r]]),
    codes: [{ id: "code", code: "LIVE", name: "Renamed code", active: true, fields: [{ id: "temperature", label: "Renamed temperature", type: "NUMBER", unit: "F", sort: 0 }] }] };
  rendered.view = { mode: "editing", canRestore: false, needsRefresh: false, savedBaseline: b, current: { stamp: permissionFixture(permissions).binding.getSnapshot().current!.stamp, data: { selectedRevision: 1, pendingRekey: null }, baseline: b } };
  const html = render();
  expect(html).toContain("Part temperature"); expect(html).not.toContain("Renamed temperature"); expect(html).not.toContain("Captured temperature");
  expect(html).toContain('value="001207"'); expect(html).toContain('value="1550"');
  expect(html).toContain("Used by an order");
  const numberInput = html.match(/<input[^>]*value="001207"[^>]*>/)?.[0];
  expect(numberInput).toContain('disabled=""');
});

it("allows saving an identical-content row replacement with a new identity", () => {
  const h = permissionFixture(permissions);
  const view = h.binding.getSnapshot(); const original = view.current!;
  const revision = original.baseline.revisions.get(1)!;
  const baseline = { ...original.baseline, document: { revision, baselineToken: "token", codes: original.baseline.codes.map(c => ({ ...c, defaultInstruction: "" })) } };
  rendered.view = { ...view, savedBaseline: baseline, current: { ...original, baseline, data: { ...original.data,
    orderedEdits: new Map([[1, [{ clientId: "new:11111111-1111-4111-8111-111111111111", stepId: null, codeId: "code", instruction: "Saved instruction", parameters: [{ key: "temperature", label: "Temperature", type: "NUMBER", unit: "F", value: "500" }] }]]]),
  } } };
  const save = render().match(/<button\b[^>]*>Save process steps<\/button>/)?.[0];
  expect(save).toBeDefined(); expect(save).not.toContain('disabled=""');
});
