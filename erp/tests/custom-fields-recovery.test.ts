import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createDraftStore } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import { customFieldsRecoveryAdapter as adapter, customFieldsRows, prepareCustomFields, readCustomFields, type CustomFieldRow, type CustomFieldsBaseline, type CustomFieldsDraft } from "../src/lib/custom-fields-recovery";

const baseline = (): CustomFieldsBaseline => ({ partId: "part", permissions: ["parts.view", "parts.edit"], rows: [
  { fieldId: "field-a", name: "A", type: "TEXT", sort: 0, active: true, value: "original" },
  { fieldId: "field-b", name: "B", type: "NUMBER", sort: 1, active: true, value: "5" },
  { fieldId: "check", name: "Checkbox", type: "CHECKBOX", sort: 2, active: true, value: "true" },
] });
const clean = (b: CustomFieldsBaseline): CustomFieldsDraft => ({ values: new Map(b.rows.map(r => [r.fieldId, r.value])), original: new Map(b.rows.map(r => [r.fieldId, r.value])) });
function open(b = baseline()) {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!;
  const binding = store.bind({ owner, record: { kind: "part", id: "part" }, editor: adapter.kind }, { label: "Custom fields", href: "/parts/part" }, adapter);
  const detach = binding.attach("first"); const id = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId: id, baseline: b, editable: true }, clean(b));
  const edit = (fieldId: string, value: string) => binding.change(d => ({ ...d, values: new Map(d.values).set(fieldId, value) }));
  const read = (fresh: CustomFieldsBaseline) => { const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: fresh, editable: true }, clean(fresh)); return readId; };
  return { store, binding, detach, edit, read };
}
it.each(["", "  invalid raw value  ", "false", "true"])("retains raw %j without normalization and restores explicitly", raw => {
  const h = open(); h.edit("check", raw); h.edit("field-a", "unsaved"); h.detach(); h.binding.attach("return"); const id = h.read(baseline());
  expect(h.store.getSnapshot().count).toBe(1); expect(h.binding.getSnapshot().mode).toBe("offer");
  expect(h.binding.getSnapshot().current?.data.values.get("check")).toBe(raw);
  expect(h.binding.restore(h.binding.getSnapshot().current!.stamp, id)).toBe(true);
  expect(h.binding.getSnapshot().current?.data.values.get("check")).toBe(raw);
});
it("only compares changed targets and reconstructs fresh clean/added rows with fresh metadata", () => {
  const h = open(); h.edit("field-a", "mine"); h.detach(); h.binding.attach("return");
  const fresh = baseline(); const incoming = { ...fresh, rows: [
    { ...fresh.rows[1], value: "9", sort: 0 }, { ...fresh.rows[0], name: "Renamed", sort: 1 }, fresh.rows[2],
    { fieldId: "added", name: "Added", type: "TEXT", sort: 3, active: true, value: "new server value" },
  ] };
  const id = h.read(incoming); expect(h.binding.getSnapshot().canRestore).toBe(true);
  expect(h.binding.restore(h.binding.getSnapshot().current!.stamp, id)).toBe(true);
  const current = h.binding.getSnapshot().current!;
  expect(customFieldsRows(current.data, current.baseline).map(r => [r.fieldId, r.name, r.value])).toEqual([
    ["field-b", "B", "9"], ["field-a", "Renamed", "mine"], ["check", "Checkbox", "true"], ["added", "Added", "new server value"],
  ]);
  expect(current.data.original.get("field-b")).toBe("9");
});
it.each(["removed", "type", "active", "value"])("refuses a changed target whose %s changed", kind => {
  const h = open(); h.edit("field-a", "mine"); h.detach(); h.binding.attach("return"); const b = baseline();
  const rows = kind === "removed" ? b.rows.slice(1) : b.rows.map(r => r.fieldId !== "field-a" ? r : { ...r,
    ...(kind === "type" ? { type: "NUMBER" } : kind === "active" ? { active: false } : { value: "theirs" }) });
  h.read({ ...b, rows }); expect(h.binding.getSnapshot().mode).toBe("conflict"); expect(h.binding.getSnapshot().canRestore).toBe(false);
  expect(h.binding.getSnapshot().current?.data.values.get("field-a")).toBe("mine");
});
it("does not equate a missing original with an explicit empty original", () => {
  const b = baseline(); const d = clean(b); const missing = { ...d, original: new Map([...d.original].filter(([id]) => id !== "field-a")), values: new Map(d.values).set("field-a", "") };
  expect(adapter.dirty(missing, b)).toBe(true);
  expect(adapter.dirty({ ...missing, original: new Map(missing.original).set("field-a", "") }, b)).toBe(false);
});
it("captures only changed values, preserves later raw text and acknowledges before refresh", () => {
  const h = open(); h.edit("field-a", "submitted value");
  const captured = prepareCustomFields(h.binding, "request")!; expect(captured).not.toBeNull();
  if (!captured) return;
  expect(captured.submission.payload).toEqual({ values: [{ fieldId: "field-a", value: "submitted value" }] });
  expect(h.binding.dispatched(captured.submission)).toBe(true); h.edit("field-a", "typed during save"); h.edit("field-b", "not-a-number");
  h.binding.settle(captured.submission, { kind: "persisted", response: undefined });
  const afterSave = h.binding.getSnapshot().current!.data;
  expect(afterSave.values.get("field-a")).toBe("typed during save"); expect(afterSave.original.get("field-a")).toBe("submitted value");
  expect(afterSave.values.get("field-b")).toBe("not-a-number"); expect(afterSave.original.get("field-b")).toBe("5");
  expect(h.binding.getSnapshot().needsRefresh).toBe(true); expect(prepareCustomFields(h.binding, "repeat")).toBeNull();
});
it("known trimmed persistence does not leave unchanged submitted whitespace retryable", () => {
  const h = open(); h.edit("field-a", "  sent  "); const submitted = h.binding.capture({ values: [{ fieldId: "field-a", value: "  sent  " }] }, "save");
  h.binding.dispatched(submitted); h.binding.settle(submitted, { kind: "persisted", response: undefined });
  expect(h.binding.getSnapshot().current?.data.values.get("field-a")).toBe("sent");
  expect(h.binding.getSnapshot().current?.data.original.get("field-a")).toBe("sent");
  expect(h.store.getSnapshot().count).toBe(0);
});
it.each(["rejected", "unknown"] as const)("%s retains text and never grants implicit retry", kind => {
  const h = open(); h.edit("field-a", "mine"); const submitted = h.binding.capture({ values: [{ fieldId: "field-a", value: "mine" }] }, "save");
  h.binding.dispatched(submitted); h.binding.settle(submitted, { kind });
  expect(h.binding.getSnapshot().current?.data.values.get("field-a")).toBe("mine"); expect(h.store.getSnapshot().count).toBe(1);
  if (kind === "unknown") { expect(h.binding.getSnapshot().mode).toBe("conflict"); expect(h.binding.getSnapshot().canRestore).toBe(false); }
});
it("a discarded captured generation cannot settle over its replacement", () => {
  const h = open(); h.edit("field-a", "submitted"); const s = h.binding.capture({ values: [{ fieldId: "field-a", value: "submitted" }] }, "save"); h.binding.dispatched(s);
  h.binding.discard(h.binding.getSnapshot().current!.stamp); h.edit("field-b", "replacement"); const current = h.binding.getSnapshot().current;
  h.binding.settle(s, { kind: "persisted", response: undefined }); expect(h.binding.getSnapshot().current).toBe(current);
  expect(current?.data.values.get("field-b")).toBe("replacement");
});
it("malformed map or row projections enter error with usable stamped Discard", () => {
  const h = open(); h.edit("field-a", "mine"); const stamp = h.binding.getSnapshot().current!.stamp;
  const bad = { ...baseline(), rows: "malformed" } as unknown as CustomFieldsBaseline;
  const id = h.binding.beginRead(); h.binding.acceptRead({ kind: "authorized", readId: id, editable: true, baseline: bad }, clean(baseline()));
  expect(h.binding.getSnapshot().mode).toBe("error"); expect(h.binding.getSnapshot().canRestore).toBe(false);
  h.binding.discard(stamp); expect(h.store.getSnapshot().count).toBe(0);
  expect(adapter.valid({ values: [], original: new Map() }, baseline())).toBe(false);
});
it("previews preserve selectable raw text and do not write or normalize", () => {
  const b = baseline(); const d = { ...clean(b), values: new Map(clean(b).values).set("field-b", "  invalid  ") };
  expect(adapter.preview(d, b)).toContainEqual({ label: "B", value: "  invalid  " });
  const data = d.values.get("field-b"); expect(data).toBe("  invalid  ");
});
// Owner ruling 2026-10-06: a pending save wins over the restart for every editor, not only one
// that takes a new seed. The discarded save is not cancelled, so no read is started under it.
it("a discard from the Shell's panel during the held rows read, with a save in flight, restarts nothing", async () => {
  const h = open(); const session = createDraftSession(h.store); h.edit("field-a", "submitted");
  const captured = prepareCustomFields(h.binding, "request")!; expect(h.binding.dispatched(captured.submission)).toBe(true);
  let release!: (rows: readonly CustomFieldRow[]) => void;
  const held = new Promise<readonly CustomFieldRow[]>(resolve => { release = resolve; });
  const readRows = vi.fn<() => Promise<readonly CustomFieldRow[]>>(async () => baseline().rows).mockImplementationOnce(() => held);
  const accepted = vi.fn<(id: number) => void>();
  const reading = readCustomFields({ binding: h.binding, session, partId: "part", readRows, accepted,
    readIdentity: async () => ({ id: "user", permissions: ["parts.view", "parts.edit"] }) });
  expect(readRows).toHaveBeenCalledTimes(1);
  h.store.discard(h.store.getSnapshot().rows[0].stamps);
  release(baseline().rows);
  expect(await reading).toBe(false);
  expect(readRows).toHaveBeenCalledTimes(1); expect(accepted).not.toHaveBeenCalled();
  expect(h.binding.getSnapshot().mode).toBe("loading"); expect(h.binding.getSnapshot().current).toBeUndefined();
});
it("a discard from the Shell's panel during the held rows read restarts that read once and lands in clean editing (#454)", async () => {
  const h = open(); const session = createDraftSession(h.store); h.edit("field-a", "unsaved");
  let release!: (rows: readonly CustomFieldRow[]) => void;
  const held = new Promise<readonly CustomFieldRow[]>(resolve => { release = resolve; });
  const fresh = { ...baseline(), rows: baseline().rows.map(r => r.fieldId === "field-a" ? { ...r, value: "saved elsewhere" } : r) };
  const readRows = vi.fn<() => Promise<readonly CustomFieldRow[]>>(async () => fresh.rows).mockImplementationOnce(() => held);
  const accepted = vi.fn<(id: number) => void>();
  const reading = readCustomFields({ binding: h.binding, session, partId: "part", readRows, accepted,
    readIdentity: async () => ({ id: "user", permissions: ["parts.view", "parts.edit"] }) });
  expect(readRows).toHaveBeenCalledTimes(1); expect(h.binding.getSnapshot().mode).toBe("loading");
  h.store.discard(h.store.getSnapshot().rows[0].stamps);
  expect(h.store.getSnapshot().count).toBe(0);
  release(baseline().rows);
  expect(await reading).toBe(true);
  expect(readRows).toHaveBeenCalledTimes(2); expect(accepted).toHaveBeenCalledTimes(1);
  const view = h.binding.getSnapshot();
  expect(view.mode).toBe("editing"); expect(view.needsRefresh).toBe(false); expect(view.reference).toBeUndefined();
  // The restarted read's rows are the ones adopted, never the answer fetched before the discard.
  expect(view.current!.data.values.get("field-a")).toBe("saved elsewhere");
  expect(adapter.dirty(view.current!.data, view.current!.baseline)).toBe(false);
  expect(h.store.getSnapshot().count).toBe(0);
});

// Ruling 28 (P7 step 8): the section's Discard is its own `discardChanges`, lifted whole from
// CustomFieldsSection.tsx and run against the real store and adapter.
function discardChangesOf(env: Record<string, unknown>): () => void {
  const text = readFileSync(new URL("../src/app/parts/[id]/CustomFieldsSection.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("CustomFieldsSection.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "discardChanges") body = node;
    ts.forEachChild(node, visit);
  };
  visit(source); expect(body, "discardChanges").toBeDefined();
  const js = ts.transpileModule(`return (${body!.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env)) as () => void;
}
it("Discard puts the saved values back, keeps the section editing and clears its message", () => {
  const h = open(); h.edit("field-a", "typed"); h.edit("field-b", "7");
  const onError = vi.fn();
  discardChangesOf({ binding: h.binding, view: h.binding.getSnapshot(), onError })();
  const after = h.binding.getSnapshot();
  expect(after.mode).toBe("editing");
  expect([...after.current!.data.values]).toEqual([...after.current!.data.original]);
  expect(after.current!.data.values.get("field-a")).toBe("original");
  expect(h.store.getSnapshot().count).toBe(0);
  expect(onError).toHaveBeenCalledWith(null);
  h.edit("field-a", "again"); expect(h.binding.getSnapshot().current!.data.values.get("field-a")).toBe("again");
});
it("the Discard button is the section's own, held while its save is out", () => {
  const text = readFileSync(new URL("../src/app/parts/[id]/CustomFieldsSection.tsx", import.meta.url), "utf8");
  expect(text).toContain('<DiscardButton section="Custom fields" dirty={dirty.length > 0} pending={saving} onDiscard={discardChanges} />');
});
