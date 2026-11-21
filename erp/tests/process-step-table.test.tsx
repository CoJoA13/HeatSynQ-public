import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { ProcessStepTable, STEP_DRAG_TYPE, StepActionsMenu, type StepFocus } from "@/app/parts/[id]/ProcessStepTable";
import { ProcessCodeSearch, ProcessCodeListbox, searchOptions, suggestionSummary, MAX_SEARCH_OPTIONS } from "@/app/parts/[id]/ProcessCodeSearch";
import { insertProcessStep, type ProcessDraftStep } from "@/lib/process-document";
import type { ProcessEditorCode } from "@/lib/process-editor-catalog";
import { UNDO_WINDOW_MS, expireUndo, focusAfterAdd, offerUndo, removeStepAt, stepFromCode, undoRemove, type UndoOffer } from "@/lib/process-table";
import { api, ApiError } from "@/lib/fetcher";
import { createDraftStore, type EditorView } from "@/lib/draft-store";
import { prepareProcessSteps, processDraftSteps, processStepsRecoveryAdapter, type ProcessRevision, type ProcessStepsBaseline, type ProcessStepsDraft, type ProcessStepsIntent } from "@/lib/process-steps-recovery";

// The Process Steps table (spec 2026-09-26 §4), rendered with `renderToStaticMarkup` — vitest runs
// in "node" with no DOM, the `process-editor.test.tsx` precedent this file replaces. Static markup
// proves the accessible structure the browser flows (Task 10) locate by; the section's own
// handlers are extracted from its source and EXECUTED against stubs (the `task-8-callbacks`
// technique), so the undo timer, the insert clamp and the save-clears-undo rule are proved on the
// code that ships, not on a copy.

const catalog: ProcessEditorCode[] = [
  { id: "heat", code: "HT", name: "Heat treat", active: true, defaultInstruction: "Hold\nthen cool",
    fields: [{ id: "temp", label: "Temperature", type: "NUMBER", unit: "°F", sort: 0 }, { id: "time", label: "Time", type: "NUMBER", unit: " min ", sort: 1 }] },
  { id: "wash", code: "WS", name: "Wash", active: true, defaultInstruction: "", fields: [] },
  { id: "old", code: "OLD", name: "Retired heat", active: false, defaultInstruction: "", fields: [] },
];
const rows: ProcessDraftStep[] = [
  { clientId: "a", stepId: "a", codeId: "heat", instruction: "First line\n\nLast line", parameters: [
    { key: "temp", label: "Temperature", type: "NUMBER", unit: "°F", value: "1500.50" },
    { key: "due", label: "Due", type: "DATE", unit: null, value: "" },
    { key: "present", label: "Present", type: "CHECKBOX", unit: null, value: "true" },
    { key: "new:11111111-1111-4111-8111-111111111111", label: "", type: "TEXT", unit: null, value: "" },
  ] },
  { clientId: "b", stepId: "b", codeId: "wash", instruction: "", parameters: [] },
];
const noop = () => {};
function table(overrides: Partial<Parameters<typeof ProcessStepTable>[0]> = {}) {
  return renderToStaticMarkup(<ProcessStepTable rows={rows} catalog={catalog} disabled={false} focus={null}
    onChange={noop} onInsertAt={noop} onRemove={noop} {...overrides} />);
}
/** The one opening tag carrying this exact attribute, so an assertion is about THAT control. */
function tag(html: string, attribute: string): string {
  const matches = html.match(new RegExp(`<(?:input|textarea|button|td|th|tr)\\b[^>]*${attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^>]*>`, "g")) ?? [];
  expect(matches, attribute).toHaveLength(1);
  return matches[0]!;
}
// The opacity classes carry the important modifier: the unlayered `button:disabled` rule in
// globals.css sets `opacity: 1`, which a plain layered utility cannot beat, so without it a
// disabled chip shows on every row (owner ruling 2026-09-27). e2e process-traveler-editor proves
// the computed opacity in a browser; this pins the classes.
const CHIP = "opacity-0! pointer-events-none group-hover:opacity-100! group-hover:pointer-events-auto focus:opacity-100! focus:pointer-events-auto";

describe("ProcessStepTable — accessible structure", () => {
  it("is one fixed-layout table whose visible headers are #, Step and Instructions & parameters; the handle and ⋮ columns are named only for screen readers", () => {
    const html = table();
    expect(html).toContain('<table id="process-steps-table" class="w-full table-fixed');
    const headers = html.match(/<th\b[^>]*>[\s\S]*?<\/th>/g) ?? [];
    expect(headers.map(h => h.replace(/<[^>]+>/g, ""))).toEqual(["Reorder", "#", "Step", "Instructions &amp; parameters", "", "Actions"]);
    expect(headers[0]).toContain('class="sr-only"'); expect(headers[5]).toContain('class="sr-only"');
  });

  it("renders each step as a hover group row keyed by its client id, numbered, with the code name over the code", () => {
    const html = table();
    expect(tag(html, 'data-step-id="a"')).toContain('class="group relative');
    expect(tag(html, 'data-step-id="b"')).toBeDefined();
    const step = html.slice(html.indexOf('data-step-id="a"'), html.indexOf('data-step-id="b"'));
    expect(step.indexOf("Heat treat")).toBeGreaterThan(-1);
    expect(step.indexOf("Heat treat")).toBeLessThan(step.indexOf(">HT<"));
    expect(html).toMatch(/<td[^>]*>1<\/td>/); expect(html).toMatch(/<td[^>]*>2<\/td>/);
  });

  it("reads each parameter like the printed line — a name input, the value labelled by the parameter's label, a unit input and ✕", () => {
    const html = table();
    expect(tag(html, 'aria-label="Step 1 parameter 1 name"')).toContain('value="Temperature"');
    expect(tag(html, 'aria-label="Step 1 Temperature"')).toContain('value="1500.50"');
    expect(tag(html, 'aria-label="Step 1 Temperature unit"')).toContain('value="°F"');
    expect(tag(html, 'aria-label="Remove Temperature from step 1"')).toContain("<button");
    // The rows are the part's own: the catalog's suggestion "Time" is not a row of this step.
    expect(html).not.toContain('aria-label="Step 1 Time"');
  });

  it("names an unnamed parameter's controls by position, so a blank label never leaves an input unnamed", () => {
    const html = table();
    expect(tag(html, 'aria-label="Step 1 parameter 4 name"')).toContain('value=""');
    expect(tag(html, 'aria-label="Step 1 parameter 4 value"')).toContain("<input");
    expect(tag(html, 'aria-label="Step 1 parameter 4 unit"')).toContain("<input");
    expect(tag(html, 'aria-label="Remove parameter 4 from step 1"')).toContain("<button");
  });

  it("types the value input by the row's type: NUMBER is decimal, DATE is a date, CHECKBOX is a checkbox with a Clear button", () => {
    const html = table();
    expect(tag(html, 'aria-label="Step 1 Temperature"')).toContain('inputMode="decimal"');
    expect(tag(html, 'aria-label="Step 1 Due"')).toContain('type="date"');
    const checkbox = tag(html, 'aria-label="Step 1 Present"');
    expect(checkbox).toContain('type="checkbox"'); expect(checkbox).toContain('checked=""');
    expect(tag(html, 'aria-label="Clear Present for step 1"')).toContain("<button");
    expect(html).toContain(">Clear</button>");
  });

  it("outlines an empty value amber and leaves a filled one alone", () => {
    const html = table();
    expect(tag(html, 'aria-label="Step 1 Due"')).toContain("ring-1 ring-accent-400");
    expect(tag(html, 'aria-label="Step 1 parameter 4 value"')).toContain("ring-1 ring-accent-400");
    expect(tag(html, 'aria-label="Step 1 Temperature"')).not.toContain("ring-accent-400");
    expect(tag(html, 'aria-label="Step 1 Present"')).not.toContain("ring-accent-400");
  });

  it("gives each step an auto-growing, resizable instruction box that the flows find by its placeholder", () => {
    const html = table();
    const box = tag(html, 'aria-label="Step 1 instructions"');
    expect(box).toContain("<textarea"); expect(box).toContain("[field-sizing:content]"); expect(box).toContain("min-h-10");
    expect(box).toContain("resize-y"); expect(box).not.toContain("resize-none");
    expect(box).toContain('maxLength="4000"'); expect(box).toContain('placeholder="Instruction"');
    expect(html).toContain("First line\n\nLast line");
    expect(tag(html, 'aria-label="Step 2 instructions"')).toContain("<textarea");
  });

  it("holds the + Insert and + Parameter chips on the row's edges as real buttons, inert until the row is hovered or the chip is focused", () => {
    const html = table();
    for (const label of ['aria-label="Insert a step above step 1"', 'aria-label="Add a parameter to step 1"', 'aria-label="Insert a step above step 2"']) {
      const chip = tag(html, label);
      expect(chip).toContain("<button"); expect(chip).toContain(CHIP);
    }
  });

  it("makes the handle a draggable button named for its step and the ⋮ a menu button", () => {
    const html = table();
    const handle = tag(html, 'aria-label="Move step 1"');
    expect(handle).toContain("<button"); expect(handle).toContain('draggable="true"');
    const menu = tag(html, 'aria-label="Step 2 actions"');
    expect(menu).toContain('aria-haspopup="menu"'); expect(menu).toContain('aria-expanded="false"');
    expect(html).toContain('aria-live="polite"');
  });

  it("carries the greyed sign-off cue as decoration, hidden below lg, in both the header and every row", () => {
    const html = table();
    const cells = html.match(/<td\b[^>]*aria-hidden="true"[^>]*>EQ# · OP · Date<\/td>/g) ?? [];
    expect(cells).toHaveLength(2);
    for (const cell of cells) expect(cell).toContain("hidden lg:table-cell");
    const header = html.match(/<th\b[^>]*aria-hidden="true"[^>]*>/g) ?? [];
    expect(header).toHaveLength(1); expect(header[0]).toContain("hidden w-28 py-2 lg:table-cell");
  });

  it("disables every input and button with the given reason, and no handle is draggable", () => {
    const html = table({ disabled: true, title: "Requires processes.edit" });
    const controls = html.match(/<(?:input|textarea|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(15);
    for (const control of controls) {
      expect(control, control).toContain('disabled=""');
      expect(control, control).toContain('title="Requires processes.edit"');
    }
    expect(html).not.toContain('draggable="true"');
  });

  it("carries no reason and no disabled attribute while editing is allowed", () => {
    const html = table();
    expect(html).not.toContain('disabled=""'); expect(html).not.toContain("title=");
  });

  it("shows the empty state inside the table when there are no steps", () => {
    const html = table({ rows: [] });
    expect(html).toContain("No steps yet. Search for a code below to add the first step.");
    expect(html).toContain("<table"); expect(html).not.toContain("data-step-id");
  });

  it("falls back to the code id when a step's code is not in the catalog rather than rendering an empty cell", () => {
    const html = table({ catalog: [] });
    expect(html).toContain("heat"); expect(html).toContain("wash");
  });
});

describe("StepActionsMenu — the ⋮ menu mirrors the chips and the handle", () => {
  function menu(n: number, count: number, open: boolean, extra: Partial<Parameters<typeof StepActionsMenu>[0]> = {}) {
    return renderToStaticMarkup(<StepActionsMenu n={n} count={count} open={open} disabled={false}
      onOpen={noop} onClose={noop} onAction={noop} {...extra} />);
  }
  it("offers the six actions as menu items, in order, when open", () => {
    const html = menu(2, 3, true);
    expect(html).toContain('role="menu"');
    const items = (html.match(/<button\b[^>]*role="menuitem"[^>]*>[^<]*<\/button>/g) ?? []).map(i => i.replace(/<[^>]+>/g, ""));
    expect(items).toEqual(["Insert step above", "Insert step below", "Move up", "Move down", "Add parameter", "Remove step"]);
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('disabled=""');
  });
  it("renders no menu while closed", () => {
    const html = menu(2, 3, false);
    expect(html).not.toContain('role="menu"'); expect(html).not.toContain('role="menuitem"');
    expect(tag(html, 'aria-label="Step 2 actions"')).toContain('aria-expanded="false"');
  });
  it("disables Move up on the first step and Move down on the last, each saying why", () => {
    // The rendered ATTRIBUTE, not the `disabled:` class token every item carries (the save-button precedent).
    const item = (html: string, label: string) => html.match(new RegExp(`<button\\b[^>]*role="menuitem"[^>]*>${label}</button>`))![0];
    const first = menu(1, 3, true);
    expect(item(first, "Move up")).toContain('disabled=""'); expect(item(first, "Move up")).toContain('title="Step 1 is already first"');
    expect(item(first, "Move down")).not.toContain('disabled=""');
    const last = menu(3, 3, true);
    expect(item(last, "Move down")).toContain('disabled=""'); expect(item(last, "Move down")).toContain('title="Step 3 is already last"');
    expect(item(last, "Move up")).not.toContain('disabled=""');
  });
  it("disables the whole menu with the table's reason", () => {
    const html = menu(1, 1, false, { disabled: true, title: "Superseded revision — read-only" });
    const button = tag(html, 'aria-label="Step 1 actions"');
    expect(button).toContain('disabled=""'); expect(button).toContain('title="Superseded revision — read-only"');
  });
});

describe("ProcessCodeSearch — the combobox under the table", () => {
  function search(overrides: Partial<Parameters<typeof ProcessCodeSearch>[0]> = {}) {
    return renderToStaticMarkup(<ProcessCodeSearch catalog={catalog} disabled={false} insertAt={null} stepCount={2}
      onPick={noop} onCancel={noop} {...overrides} />);
  }
  it("is a list-autocomplete combobox named for adding a step", () => {
    const html = search();
    const input = tag(html, 'role="combobox"');
    expect(input).toContain('aria-label="Add a step — search code or name"');
    expect(input).toContain('aria-autocomplete="list"'); expect(input).toContain('aria-expanded="false"');
    expect(input).toContain('placeholder="Search code or name"');
    expect(html).not.toContain('role="listbox"');
  });
  it("says where the pick will land: before a step, or at the end — and never past the end", () => {
    expect(search({ insertAt: 0 })).toContain("Inserting before step 1");
    expect(search({ insertAt: 1 })).toContain("Inserting before step 2");
    expect(search({ insertAt: 2 })).toContain("Adding at the end");
    expect(search({ insertAt: 5 })).toContain("Adding at the end");
    expect(search({ insertAt: 5 })).not.toContain("Inserting before");
    const closed = search({ insertAt: null });
    expect(closed).not.toContain("Inserting before"); expect(closed).not.toContain("Adding at the end");
  });
  it("is disabled with its reason", () => {
    const input = tag(search({ disabled: true, title: "Requires processes.edit" }), 'role="combobox"');
    expect(input).toContain('disabled=""'); expect(input).toContain('title="Requires processes.edit"');
  });
});

describe("ProcessCodeListbox and its options", () => {
  it("ranks through the shared leaf, drops inactive codes and shows at most twenty", () => {
    expect(searchOptions(catalog, "").map(c => c.id)).toEqual(["heat", "wash"]);
    expect(searchOptions(catalog, "wa").map(c => c.id)).toEqual(["wash"]);
    const many = Array.from({ length: 25 }, (_, i) => ({ ...catalog[1], id: `c${i}`, code: `C${String(i).padStart(2, "0")}` }));
    expect(MAX_SEARCH_OPTIONS).toBe(20);
    expect(searchOptions(many, "")).toHaveLength(20);
  });
  it("describes a code's suggested parameters, with normalized units, or says there are none", () => {
    expect(suggestionSummary(catalog[0])).toBe("Suggests: Temperature (°F), Time (min)");
    expect(suggestionSummary(catalog[1])).toBe("No suggested parameters");
  });
  it("renders each option as CODE — Name over its suggestion line, with stable ids and the active one selected", () => {
    const html = renderToStaticMarkup(<ProcessCodeListbox id="lb" options={searchOptions(catalog, "")} activeIndex={1} onPick={noop} />);
    expect(html).toContain('role="listbox"'); expect(html).toContain('id="lb"');
    const options = html.match(/<button\b[^>]*role="option"[^>]*>/g) ?? [];
    expect(options).toHaveLength(2);
    expect(options[0]).toContain('id="lb-0"'); expect(options[0]).toContain('aria-selected="false"');
    expect(options[1]).toContain('id="lb-1"'); expect(options[1]).toContain('aria-selected="true"');
    expect(html).toContain("HT — Heat treat"); expect(html).toContain("Suggests: Temperature (°F), Time (min)");
    expect(html).toContain("WS — Wash"); expect(html).toContain("No suggested parameters");
  });
});

// ------------------------------------------------------------------------------------------------
// The section's own wiring, executed from its source.
// ------------------------------------------------------------------------------------------------

const SECTION = "../src/app/parts/[id]/ProcessStepsSection.tsx";
const sectionSource = ts.createSourceFile(SECTION, readFileSync(new URL(SECTION, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
/** Extract one named function (a declaration, or the callback of a hook such as `useCallback`)
 *  and bind its free identifiers to `environment` — the `task-8-callbacks` technique. */
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
  return compiled<T>(found!, environment);
}
/** Evaluate one node of a component's source (a callback, an expression) with its free
 *  identifiers bound to `environment`. */
function compiled<T>(node: ts.Node, environment: Record<string, unknown>, source: ts.SourceFile = sectionSource): T {
  const code = ts.transpileModule(`return (${node.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T;
}
function nodes<T extends ts.Node>(root: ts.Node, predicate: (n: ts.Node) => n is T): T[] {
  const out: T[] = []; const walk = (n: ts.Node) => { if (predicate(n)) out.push(n); ts.forEachChild(n, walk); }; walk(root); return out;
}
const text = (node: ts.Node) => node.getText(sectionSource).replace(/\s+/g, "");
const three: ProcessDraftStep[] = [rows[0], { ...rows[1], clientId: "b" }, { clientId: "c", stepId: "c", codeId: "wash", instruction: "", parameters: [] }];

describe("ProcessStepsSection — removal offers Undo on one timer", () => {
  function harness() {
    const timers: Array<() => void> = []; let nextId = 1;
    const window = { setTimeout: vi.fn((fn: () => void) => { timers.push(fn); return nextId++; }), clearTimeout: vi.fn() };
    const env = {
      rowDisabled: false, rows: three, removeStepAt, offerUndo, expireUndo, UNDO_WINDOW_MS, window,
      undoTimer: { current: null as number | null }, undoRef: { current: null as UndoOffer },
      setUndo: vi.fn(), changeRows: vi.fn(), requestAnimationFrame: vi.fn(), undoButton: { current: null },
    };
    return { env, timers, window, removeStep: actual<(index: number) => void>("removeStep", env) };
  }
  it("removes the step as a draft edit and arms the offer for the undo window", () => {
    const h = harness();
    h.removeStep(1);
    expect(h.env.changeRows).toHaveBeenCalledWith([three[0], three[2]]);
    expect(h.window.setTimeout).toHaveBeenCalledWith(expect.any(Function), UNDO_WINDOW_MS);
    expect(h.env.undoTimer.current).toBe(1);
    expect(h.env.undoRef.current).toEqual({ removed: { step: three[1], index: 1 }, token: 1 });
    expect(h.env.setUndo).toHaveBeenLastCalledWith(h.env.undoRef.current);
  });
  it("a newer removal clears the previous timer, and an old timer that still fires can never close the newer bar", () => {
    const h = harness();
    h.removeStep(1); h.removeStep(0);
    expect(h.window.clearTimeout).toHaveBeenCalledWith(1);
    expect(h.env.undoTimer.current).toBe(2); expect(h.env.undoRef.current?.token).toBe(2);
    const newer = h.env.undoRef.current;
    h.timers[0]();                                   // the superseded timer, firing late anyway
    const late = h.env.setUndo.mock.calls.at(-1)![0] as (s: UndoOffer) => UndoOffer;
    expect(late(newer)).toBe(newer);                 // expireUndo by token: the newer offer stands
    expect(h.env.undoRef.current).toBe(newer); expect(h.env.undoTimer.current).toBe(2);
    h.timers[1]();                                   // the live timer expires the offer it armed
    const own = h.env.setUndo.mock.calls.at(-1)![0] as (s: UndoOffer) => UndoOffer;
    expect(own(newer)).toBeNull();
    expect(h.env.undoRef.current).toBeNull(); expect(h.env.undoTimer.current).toBeNull();
  });
  function undoEnv(pending: boolean) {
    const offer = offerUndo(null, { step: three[1], index: 1 });
    const env = { rowDisabled: false, rows: [three[0], three[2]], undoRef: { current: offer as UndoOffer }, pendingRef: { current: pending }, clearUndo: vi.fn(), undoRemove, applyRows: vi.fn() };
    return { env, offer, undoAction: actual<() => void>("undoAction", env) };
  }
  it("Undo restores the same row at the same place, clears the timer and focuses the restored handle", () => {
    const { env, undoAction } = undoEnv(false);
    undoAction();
    expect(env.clearUndo).toHaveBeenCalledTimes(1);
    expect(env.applyRows).toHaveBeenCalledWith(three, { clientId: "b", target: { kind: "handle" } });
    env.undoRef.current = null; env.applyRows.mockClear();
    undoAction();
    expect(env.applyRows).not.toHaveBeenCalled();
  });
  it("Undo is refused while a save is in flight, and the offer is kept for the case where that save is refused (fix round 1)", () => {
    // The in-flight save may be deleting the removed step or cutting a revision; a reinserted
    // row would pass `mapOrdered` unchanged with its old id and 400 every later save (D-2).
    const { env, offer, undoAction } = undoEnv(true);
    undoAction();
    expect(env.applyRows).not.toHaveBeenCalled();
    expect(env.clearUndo).not.toHaveBeenCalled();          // the guard sits BEFORE the clear
    expect(env.undoRef.current).toBe(offer);
  });
  it("the Undo button is disabled on the shared pending flag with a reason, like Save and the revision picker (source)", () => {
    const button = nodes(sectionSource, (n): n is ts.JsxOpeningElement | ts.JsxSelfClosingElement => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n))
      .find(e => e.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(sectionSource) === "ref" && p.initializer && text(p.initializer) === "{undoButton}"));
    expect(button, "the Undo button").toBeDefined();
    const attribute = (name: string) => { const a = button!.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(sectionSource) === name); return a && ts.isJsxAttribute(a) && a.initializer ? text(a.initializer) : undefined; };
    expect(attribute("disabled")).toBe("{rowDisabled||pending}");
    expect(attribute("title")).toBe("{pending?UNDO_PENDING_REASON:rowTitle}");
    expect(sectionSource.getText()).toContain('const UNDO_PENDING_REASON = "Saving — Undo is unavailable until the save settles."');
  });
  it("clearUndo cancels the armed timer and drops the offer", () => {
    const env = { window: { clearTimeout: vi.fn() }, undoTimer: { current: 7 as number | null }, undoRef: { current: offerUndo(null, { step: three[1], index: 1 }) as UndoOffer }, setUndo: vi.fn() };
    actual<() => void>("clearUndo", env)();
    expect(env.window.clearTimeout).toHaveBeenCalledWith(7);
    expect(env.undoTimer.current).toBeNull(); expect(env.undoRef.current).toBeNull();
    expect(env.setUndo).toHaveBeenCalledWith(null);
  });
  it("a revision change and unmount clear the offer and its timer (source: the two effects)", () => {
    const effects = nodes(sectionSource, ts.isCallExpression).filter(c => text(c.expression) === "useEffect");
    const onRevision = effects.find(e => e.arguments[1] && text(e.arguments[1]) === "[selected,clearUndo]");
    expect(onRevision, "an effect keyed on the selected revision").toBeDefined();
    expect(nodes(onRevision!.arguments[0], ts.isCallExpression).some(c => text(c.expression) === "clearUndo")).toBe(true);
    const onUnmount = effects.find(e => e.arguments[1] && text(e.arguments[1]) === "[]" && text(e.arguments[0]).includes("window.clearTimeout(undoTimer.current)"));
    expect(onUnmount, "an unmount cleanup that clears the undo timer").toBeDefined();
    expect(ts.isArrowFunction(onUnmount!.arguments[0]) && ts.isArrowFunction(onUnmount!.arguments[0].body)).toBe(true);
  });
  it("suspended editing clears the offer, and only suspended editing: the effect keyed on `editing` (source, executed)", () => {
    // Whole-branch review, Important 1: an unknown-outcome save may have deleted the removed row
    // and committed, and editing resumes on the SAME revision number, so the effect above never
    // fires. The next describe proves, on the real store, that both saves' unknown outcome
    // suspends editing and a refusal does not.
    const effects = nodes(sectionSource, ts.isCallExpression).filter(c => text(c.expression) === "useEffect");
    const onSuspend = effects.find(e => e.arguments[1] && text(e.arguments[1]) === "[editing,clearUndo]");
    expect(onSuspend, "an effect keyed on editing").toBeDefined();
    const run = (editing: boolean) => { const clearUndo = vi.fn(); compiled<() => void>(onSuspend!.arguments[0], { editing, clearUndo })(); return clearUndo; };
    expect(run(false)).toHaveBeenCalledTimes(1);
    expect(run(true)).not.toHaveBeenCalled();
  });
});

// The real store and adapter, with the section's own `editing`, `baseline` and `selected`
// expressions evaluated from its source against each snapshot, so the predicate the effect above
// keys on is the one that ships.
describe("ProcessStepsSection — an unknown save outcome suspends editing on both saves (whole-branch review, Important 1)", () => {
  const codes = [{ id: "wash", code: "WS", name: "Wash", active: true, fields: [] }];
  const revision = (ids: readonly string[]): ProcessRevision => ({ revisionNumber: 3, lockedAt: null,
    steps: ids.map((id, i) => ({ id, position: i + 1, codeId: "wash", code: "WS", codeName: "Wash", instruction: `Instruction ${id}`, parameters: [] })) });
  /** Revision 3, a working revision: a save amends it in place, keeping its number. */
  const saved = (ids: readonly string[]): ProcessStepsBaseline => {
    const r = revision(ids);
    return { partId: "part", permissions: ["processes.view", "processes.edit"], highestRevision: 3, selectedRevision: 3, revisions: new Map([[3, r]]),
      summaries: [{ revisionNumber: 3, lockedAt: null, stepCount: ids.length, orderCount: 0, createdAt: "" }], codes, codesReady: true,
      document: { revision: r, baselineToken: `token-${ids.join("")}`, codes: codes.map(c => ({ ...c, defaultInstruction: "" })) } };
  };
  /** What the section derives from a snapshot: its own expressions, executed from source. */
  function section(view: EditorView<ProcessStepsDraft, ProcessStepsBaseline, never>) {
    const editing = actual<boolean>("editing", { view });
    const baseline = actual<ProcessStepsBaseline | undefined>("baseline", { editing, view });
    return { editing, selected: actual<number | null>("selected", { editing, view, baseline }) };
  }
  /** The part holds steps a and b; the operator removed b, the row an Undo offer would hold. */
  function removedB() {
    const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!;
    const binding = store.bind({ owner, record: { kind: "part", id: "part" }, editor: processStepsRecoveryAdapter.kind }, { label: "Process steps", href: "/parts/part" }, processStepsRecoveryAdapter);
    binding.attach("fix-wave");
    const read = (baseline: ProcessStepsBaseline) => {
      const readId = binding.beginRead();
      expect(binding.acceptRead({ kind: "authorized", readId, baseline, editable: true, recoveryAllowed: true }, { selectedRevision: 3, pendingRekey: null })).toBe(true);
    };
    read(saved(["a", "b"]));
    const [a] = processDraftSteps(binding.getSnapshot().current!.data, binding.getSnapshot().current!.baseline, 3);
    binding.change(d => ({ ...d, orderedEdits: new Map([[3, [a]]]) }));
    expect(section(binding.getSnapshot())).toEqual({ editing: true, selected: 3 });
    return { binding, read, view: () => section(binding.getSnapshot()) };
  }
  function dispatch(h: ReturnType<typeof removedB>, kind: "document" | "recipe-number") {
    if (kind === "recipe-number") h.binding.change(d => ({ ...d, recipeNumberEdit: "0042" }));
    // The document intent's rows are rebuilt from the draft by `prepareProcessSteps`.
    const intent: ProcessStepsIntent = kind === "document" ? { kind, document: { expectedBaselineToken: "ignored", steps: [] } } : { kind, recipeNumber: "0042", expectedRecipeNumber: null };
    const captured = prepareProcessSteps(h.binding, intent, `save-${kind}`);
    expect(captured?.submission.payload.kind).toBe(kind);
    expect(h.binding.dispatched(captured!.submission)).toBe(true);
    // In flight, editing stands: Undo's own pending refusal (fix round 1) holds the offer then.
    expect(h.view().editing).toBe(true);
    return captured!.submission;
  }
  it("document save: the unknown outcome suspends editing, and a recovery read that finds the save committed resumes it on the same revision", () => {
    const h = removedB();
    h.binding.settle(dispatch(h, "document"), { kind: "unknown" });
    expect(h.view().editing).toBe(false);
    // The server deleted b and amended revision 3 in place; the reconciling read resumes editing
    // on revision 3, where the old offer would have reinserted b's deleted id.
    h.read(saved(["a"]));
    expect(h.binding.getSnapshot().mode).toBe("editing");
    expect(h.view()).toEqual({ editing: true, selected: 3 });
    expect(processDraftSteps(h.binding.getSnapshot().current!.data, h.binding.getSnapshot().current!.baseline, 3).map(s => s.stepId)).toEqual(["a"]);
  });
  it("recipe-number save: the unknown outcome suspends editing, and the recovery notice's Discard resumes it on the same revision", () => {
    const h = removedB();
    h.binding.settle(dispatch(h, "recipe-number"), { kind: "unknown" });
    expect(h.view().editing).toBe(false);
    h.binding.discard(h.binding.getSnapshot().current!.stamp);
    expect(h.view()).toEqual({ editing: true, selected: 3 });
    // b is back from the baseline, so the old offer would have inserted it a second time.
    expect(processDraftSteps(h.binding.getSnapshot().current!.data, h.binding.getSnapshot().current!.baseline, 3).map(s => s.stepId)).toEqual(["a", "b"]);
  });
  it.each(["document", "recipe-number"] as const)("%s save: a refused (4xx) save keeps editing, so the effect leaves its offer (fix round 1)", kind => {
    const h = removedB();
    h.binding.settle(dispatch(h, kind), { kind: "rejected" });
    expect(h.view()).toEqual({ editing: true, selected: 3 });
  });
});

describe("ProcessStepsSection — a successful save invalidates the offer (ruling D-2)", () => {
  const document = { expectedBaselineToken: "token", steps: three };
  function binding(generation = 1) {
    return { dispatched: vi.fn(() => true), settle: vi.fn(), getSnapshot: () => ({ current: { stamp: { generation } } }) };
  }
  function processEnv(api: (path: string, init?: RequestInit) => Promise<unknown>) {
    const b = binding();
    const env = {
      binding: b, partId: "part", rowDisabled: false, document, pendingRef: { current: false }, setPending: vi.fn(), setSaveError: vi.fn(),
      prepareProcessSteps: () => ({ binding: b, submission: { payload: { kind: "document", document }, stamp: { generation: 1 } } }),
      newId: () => "request", api: vi.fn(api), ApiError, mounted: { current: true }, onError: vi.fn(), invalidateHistory: vi.fn(), refreshAfter: vi.fn(), clearUndo: vi.fn(),
      readAgainIfStale: vi.fn(), // #659: the 409 follow-up read (tests/process-steps-stale-409.test.ts)
    };
    return { env, action: actual<() => Promise<void>>("saveProcessAction", env) };
  }
  it("process save: clears the offer once the server has acknowledged the deletion, before history and refresh", async () => {
    const result = { baseline: { revision: { revisionNumber: 2 }, baselineToken: "t2", codes: [] }, stepIdMap: {}, parameterKeys: {} };
    const h = processEnv(async () => result);
    await h.action();
    expect(h.env.binding.settle).toHaveBeenCalledWith(expect.anything(), { kind: "persisted", response: { revisionNumber: 2, document: result } });
    expect(h.env.clearUndo).toHaveBeenCalledTimes(1);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];
    expect(order(h.env.binding.settle)).toBeLessThan(order(h.env.clearUndo));
    expect(order(h.env.clearUndo)).toBeLessThan(order(h.env.invalidateHistory));
    expect(order(h.env.clearUndo)).toBeLessThan(order(h.env.refreshAfter));
  });
  it("process save: a refused save deletes nothing, so the offer stays", async () => {
    const h = processEnv(async () => { throw new ApiError("The process changed — reload before saving", 409); });
    await h.action();
    expect(h.env.binding.settle).toHaveBeenCalledWith(expect.anything(), { kind: "rejected" });
    expect(h.env.clearUndo).not.toHaveBeenCalled();
    expect(h.env.setSaveError).toHaveBeenCalledWith("The process changed — reload before saving");
  });
  function recipeEnv(api: (path: string, init?: RequestInit) => Promise<unknown>) {
    const b = binding();
    const env = {
      binding: b, partId: "part", numberDisabled: false, numberValue: "001", savedNumber: null, pendingRef: { current: false }, setPending: vi.fn(),
      prepareProcessSteps: () => ({ binding: b, submission: { payload: { kind: "recipe-number", recipeNumber: "001", expectedRecipeNumber: null }, stamp: { generation: 1 } } }),
      newId: () => "request", api: vi.fn(api), ApiError, mounted: { current: true }, onError: vi.fn(), invalidateHistory: vi.fn(), refreshAfter: vi.fn(), clearUndo: vi.fn(),
      readAgainIfStale: vi.fn(), // #659: the 409 follow-up read (tests/process-steps-stale-409.test.ts)
    };
    return { env, action: actual<() => Promise<void>>("saveRecipeNumberAction", env) };
  }
  it("recipe-number save: a cut re-keys every step, so the acknowledgement clears the offer", async () => {
    const h = recipeEnv(async () => ({ recipeNumber: "001", revisionNumber: 2, stepIdMap: { a: "a2" } }));
    await h.action();
    expect(h.env.binding.settle).toHaveBeenCalledWith(expect.anything(), { kind: "persisted", response: { recipeNumber: "001", revisionNumber: 2, stepIdMap: { a: "a2" } } });
    expect(h.env.clearUndo).toHaveBeenCalledTimes(1);
    expect(h.env.binding.settle.mock.invocationCallOrder[0]).toBeLessThan(h.env.clearUndo.mock.invocationCallOrder[0]);
  });
  it("recipe-number save: a refusal leaves the offer", async () => {
    const h = recipeEnv(async () => { throw new ApiError("Recipe number in use", 409); });
    await h.action();
    expect(h.env.binding.settle).toHaveBeenCalledWith(expect.anything(), { kind: "rejected" });
    expect(h.env.clearUndo).not.toHaveBeenCalled();
  });
  it.each([
    ["process", () => processEnv, { baseline: { revision: { revisionNumber: 2 }, baselineToken: "t2", codes: [] }, stepIdMap: {}, parameterKeys: {} }],
    ["recipe-number", () => recipeEnv, { recipeNumber: "001", revisionNumber: 2, stepIdMap: { a: "a2" } }],
  ] as const)("%s save: while the request is open the shared pendingRef refuses Undo (fix round 1)", async (_kind, make, result) => {
    let release!: () => void; const held = new Promise<void>(yes => { release = yes; });
    const h = make()(async () => { await held; return result; });
    const running = h.action();
    expect(h.env.pendingRef.current).toBe(true);
    // The same ref object the section's `undoAction` reads: an Undo click during this window is refused.
    const offer = offerUndo(null, { step: three[1], index: 1 });
    const undo = { rowDisabled: false, rows: [three[0], three[2]], undoRef: { current: offer as UndoOffer }, pendingRef: h.env.pendingRef, clearUndo: vi.fn(), undoRemove, applyRows: vi.fn() };
    actual<() => void>("undoAction", undo)();
    expect(undo.applyRows).not.toHaveBeenCalled(); expect(undo.clearUndo).not.toHaveBeenCalled();
    release(); await running;
    expect(h.env.pendingRef.current).toBe(false);
    expect(h.env.clearUndo).toHaveBeenCalledTimes(1); // and once the save lands, the offer is cleared anyway (D-2)
  });
  // #364: a 5xx or a lost connection can hide a save that COMMITTED, so both actions must settle it
  // "unknown" — the outcome the real store answers by suspending editing ("an unknown save outcome
  // suspends editing on both saves"), which the `editing`-keyed effect answers by clearing the Undo
  // offer ("removal offers Undo on one timer"). Only a 4xx is a refusal the offer survives (the 409
  // cases in this describe). Each failure reaches the action through the real `api()` over a
  // stubbed global `fetch`, so it is the shape the action actually receives
  // (`src/lib/fetcher.ts`): `api()` throws `ApiError(message, status)` for any non-OK response, and
  // `trackedFetch` wraps `fetch` in a `finally` with no `catch`, so a failed connection's rejection
  // reaches the action unchanged. #547: a 200 whose body cannot be read is the third kind. `api()`
  // rejects it with `UnreadableAnswerError`, which is no ApiError, so the actions' refusal test (an
  // ApiError with a status below 500) cannot take it for a 4xx. That it carries no `status` at all is
  // fetcher.test.ts's to prove: these actions ask for the class first.
  describe("a 5xx, a network failure or an unreadable 200 settles unknown on both saves (#364, #547)", () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    const saves = {
      process: { make: processEnv, path: "/api/parts/part/process/document", method: "PUT" },
      "recipe-number": { make: recipeEnv, path: "/api/parts/part/process/recipe-number", method: "PATCH" },
    };
    const failures = {
      // No JSON error body, so `api()` reports its own generic message: the real path ran.
      "a 500 response": { respond: async () => new Response("Internal Server Error", { status: 500 }), message: "Request failed (500)" },
      // A browser's `fetch` rejects with a TypeError on a network error (the Fetch standard).
      "a network error": { respond: async (): Promise<Response> => { throw new TypeError("Failed to fetch"); }, message: "Failed to fetch" },
      // A 200 cut short: the write committed and its answer was lost, in the owner's words (#547).
      "a 200 whose body cannot be read": { respond: async () => new Response('{"id":', { status: 200 }), message: "The change was saved, but the answer could not be read. Reload the page to see it." },
    };
    it.each([
      ["process", "a 500 response"], ["process", "a network error"], ["process", "a 200 whose body cannot be read"],
      ["recipe-number", "a 500 response"], ["recipe-number", "a network error"], ["recipe-number", "a 200 whose body cannot be read"],
    ] as const)("%s save: %s settles unknown", async (kind, failure) => {
      const save = saves[kind]; const { respond, message } = failures[failure];
      const transport = vi.fn(respond); vi.stubGlobal("fetch", transport);
      const h = save.make(api);
      await h.action();
      expect(transport).toHaveBeenCalledWith(save.path, expect.objectContaining({ method: save.method }));
      expect(h.env.binding.settle).toHaveBeenCalledTimes(1);
      expect(h.env.binding.settle).toHaveBeenCalledWith(expect.anything(), { kind: "unknown" });
      // A document save's failure shows once, in the section's save-failed line (`setSaveError`),
      // never in the section message as well (G1-4, P6 step 5c); the recipe number has no such line.
      if (kind === "process") {
        expect((h.env as unknown as { setSaveError: unknown }).setSaveError).toHaveBeenCalledWith(message);
        expect(h.env.onError).not.toHaveBeenCalled();
      } else expect(h.env.onError).toHaveBeenCalledWith(message);
    });
  });
});

describe("ProcessStepsSection — insert position and the search", () => {
  function pickEnv(insertAt: number | null, current: readonly ProcessDraftStep[] = rows) {
    const env = { stepFromCode, newId: () => "22222222-2222-4222-8222-222222222222", insertProcessStep, focusAfterAdd, rows: current, insertAt, applyRows: vi.fn(), setInsertAt: vi.fn(), openerRef: { current: {} as unknown } };
    return { env, pickCode: actual<(code: ProcessEditorCode) => void>("pickCode", env) };
  }
  it("inserts the code's step at the requested position, focuses its first empty value and closes the position", () => {
    const h = pickEnv(0);
    h.pickCode(catalog[0]);
    const [next, focus] = h.env.applyRows.mock.calls[0] as [ProcessDraftStep[], StepFocus];
    expect(next.map(s => s.clientId)).toEqual(["new:22222222-2222-4222-8222-222222222222", "a", "b"]);
    expect(next[0]).toEqual(stepFromCode(catalog[0], "new:22222222-2222-4222-8222-222222222222"));
    expect(focus).toEqual({ clientId: "new:22222222-2222-4222-8222-222222222222", target: { kind: "parameter", index: 0 } });
    expect(h.env.setInsertAt).toHaveBeenCalledWith(null); expect(h.env.openerRef.current).toBeNull();
  });
  it("appends when no position is open, and focuses the instruction of a step with no parameters", () => {
    const h = pickEnv(null);
    h.pickCode(catalog[1]);
    const [next, focus] = h.env.applyRows.mock.calls[0] as [ProcessDraftStep[], StepFocus];
    expect(next.map(s => s.clientId)).toEqual(["a", "b", "new:22222222-2222-4222-8222-222222222222"]);
    expect(focus.target).toEqual({ kind: "instruction" });
  });
  it("clamps a position past the end (rows removed while the search was open) instead of throwing", () => {
    expect(() => insertProcessStep(rows, 5, three[2])).toThrow(RangeError);
    const h = pickEnv(5);
    expect(() => h.pickCode(catalog[1])).not.toThrow();
    const [next] = h.env.applyRows.mock.calls[0] as [ProcessDraftStep[]];
    expect(next.map(s => s.clientId)).toEqual(["a", "b", "new:22222222-2222-4222-8222-222222222222"]);
  });
  it("opening the search remembers the control that opened it, and Esc returns focus there", () => {
    class HTMLElement { focus = vi.fn(); }
    const chip = new HTMLElement(); const input = new HTMLElement();
    // `window.document`, never the bare name: inside the section `document` is the process document.
    const env = { rowDisabled: false, HTMLElement, window: { document: { activeElement: chip } }, document: null, openerRef: { current: null as unknown }, setInsertAt: vi.fn(),
      requestAnimationFrame: (fn: () => void) => { fn(); return 1; }, sectionRef: { current: { querySelector: vi.fn(() => input) } } };
    actual<(index: number) => void>("openInsert", env)(2);
    expect(env.setInsertAt).toHaveBeenCalledWith(2); expect(env.openerRef.current).toBe(chip);
    expect(env.sectionRef.current.querySelector).toHaveBeenCalledWith('input[role="combobox"]');
    expect(input.focus).toHaveBeenCalledTimes(1);
    env.setInsertAt.mockClear();
    actual<() => void>("cancelInsert", env)();
    expect(env.setInsertAt).toHaveBeenCalledWith(null); expect(chip.focus).toHaveBeenCalledTimes(1); expect(env.openerRef.current).toBeNull();
  });
});

// The table's drag and keyboard handlers, executed from its source the same way: static markup
// never runs a handler, and the browser flows cannot reach every branch (Playwright turns Escape
// during a drag into `dragCancel`, so no flow ever sent the handle a keydown mid-drag).
describe("ProcessStepTable — the handle's handlers (whole-branch review, Minors 1 and 5; #366)", () => {
  const TABLE = "../src/app/parts/[id]/ProcessStepTable.tsx";
  const tableSource = ts.createSourceFile(TABLE, readFileSync(new URL(TABLE, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  type Element = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  const elements = nodes(tableSource, (n): n is Element => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n));
  const attribute = (element: Element, name: string) => element.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(tableSource) === name);
  const flat = (node: ts.Node) => node.getText(tableSource).replace(/\s+/g, "");
  /** The one element carrying `name` whose opening tag matches `where`, and that handler's function. */
  function handler<T>(where: (element: Element) => boolean, name: string, environment: Record<string, unknown>): T {
    const found = elements.filter(e => where(e) && attribute(e, name));
    expect(found, name).toHaveLength(1);
    const initializer = attribute(found[0], name)!.initializer;
    expect(initializer && ts.isJsxExpression(initializer) && initializer.expression, name).toBeTruthy();
    return compiled<T>((initializer as ts.JsxExpression).expression!, environment, tableSource);
  }
  const isHandle = (e: Element) => { const label = attribute(e, "aria-label"); return !!label?.initializer && flat(label.initializer) === "{`Movestep${n}`}"; };
  const isRow = (e: Element) => e.tagName.getText(tableSource) === "tr";
  const event = (extra: Record<string, unknown> = {}) => ({ preventDefault: vi.fn(), dataTransfer: { dropEffect: "" }, ...extra });
  /** One drag's data store, kept the browser's way (HTML, "the drag data store"): `setData` files
   *  its format lower-cased and `types` lists those formats; while the drag is over a row the store
   *  is protected and `getData` answers ""; at the drop it is read-only and answers. */
  function dragData(entries: Record<string, string> = {}) {
    const store = new Map(Object.entries(entries).map(([format, data]) => [format.toLowerCase(), data]));
    return (mode: "read/write" | "protected" | "read-only") => ({
      dropEffect: "", effectAllowed: "uninitialized",
      get types() { return [...store.keys()]; },
      setData(format: string, data: string) { if (mode === "read/write") store.set(format.toLowerCase(), data); },
      getData(format: string) { return mode === "protected" ? "" : store.get(format.toLowerCase()) ?? ""; },
    });
  }
  type DataTransferStub = ReturnType<ReturnType<typeof dragData>>;
  /** Files ANOTHER row's id, one present in `three`, under `text/plain`, where the handle filed its
   *  own until #397, so which format a drop reads is observable: one reading that entry instead of
   *  the table's own type moves the wrong row, moves where nothing may, or fails to move, and reds. */
  const decoy = (data: ReturnType<typeof dragData>, clientId: string) => data("read/write").setData("text/plain", clientId);
  /** Two mounts' tokens, the same length, so a drop that skipped the comparison and cut the id at
   *  this token's length still names a row. */
  const SCOPE = "5f0c1a52-8d3e-4b7a-9c61-2e4f8a9b0d13"; const OTHER = "a3e97c04-61b2-4f58-8d0e-7c95b3f2a146";
  /** One table's closure, shared by the handle's and the rows' handlers as the component shares it.
   *  `dragScope` is its mount's token. `drag` is the ref the table tracked a handle drag in before
   *  #366: bound here, a ref brought back is seen by the rows' handlers instead of throwing on an
   *  unbound name. */
  const tableEnv = (extra: Record<string, unknown> = {}) => ({ disabled: false, STEP_DRAG_TYPE, dragScope: SCOPE, rows: three, move: vi.fn(), drag: { current: null as string | null }, ...extra });
  type TableEnv = ReturnType<typeof tableEnv>;
  function fire(where: (element: Element) => boolean, name: string, env: Record<string, unknown>, dataTransfer: DataTransferStub) {
    const e = event({ dataTransfer });
    handler<(e: unknown) => void>(where, name, env)(e);
    return e as ReturnType<typeof event> & { dataTransfer: DataTransferStub };
  }
  const dragStart = (env: TableEnv, step: ProcessDraftStep, dataTransfer: DataTransferStub) => fire(isHandle, "onDragStart", { ...env, step }, dataTransfer);
  const dragOver = (env: TableEnv, index: number, dataTransfer: DataTransferStub) => fire(isRow, "onDragOver", { ...env, index }, dataTransfer);
  const drop = (env: TableEnv, index: number, dataTransfer: DataTransferStub) => fire(isRow, "onDrop", { ...env, index }, dataTransfer);
  it("dragstart files its table's token and the dragged row's client id under the table's private type, which the browser keeps lower-cased (#366)", () => {
    const data = dragData(); const env = tableEnv();
    const e = dragStart(env, three[1], data("read/write"));
    expect(e.preventDefault).not.toHaveBeenCalled(); expect(e.dataTransfer.effectAllowed).toBe("move");
    expect(data("read-only").types).toContain(STEP_DRAG_TYPE);
    expect(data("read-only").getData(STEP_DRAG_TYPE)).toBe(`${SCOPE} b`);
  });
  it("dragstart files nothing but the private type: a field outside the table takes a dropped `text/plain`, so the handle files none (#397)", () => {
    const data = dragData();
    dragStart(tableEnv(), three[1], data("read/write"));
    // The whole list, not the absence of one format: the id filed under any other name reds too.
    expect(data("read-only").types).toEqual([STEP_DRAG_TYPE]);
  });
  it("a handle drag is the table's: its dragover is accepted as a move, and its drop moves the dragged row to the drop row", () => {
    const data = dragData(); const env = tableEnv();
    dragStart(env, three[0], data("read/write")); decoy(data, "b");
    const over = dragOver(env, 2, data("protected"));
    expect(over.preventDefault).toHaveBeenCalledTimes(1); expect(over.dataTransfer.dropEffect).toBe("move");
    const dropped = drop(env, 2, data("read-only"));
    expect(dropped.preventDefault).toHaveBeenCalledTimes(1);
    expect(env.move).toHaveBeenCalledWith(0, 2);
    // A disabled table accepts no handle drag over its rows.
    const refused = dragOver(tableEnv({ disabled: true }), 2, data("protected"));
    expect(refused.preventDefault).not.toHaveBeenCalled(); expect(refused.dataTransfer.dropEffect).toBe("");
  });
  it("any other drag is the browser's, even after a handle drag whose dragend never came: no preventDefault and no move, so text drops into the row's inputs (#366)", () => {
    const env = tableEnv();
    // A handle drag starts, then its handle unmounts mid-drag (a save settling re-keys the row, a
    // re-read shows the loading view), so React delivers no dragend to it.
    dragStart(env, three[0], dragData()("read/write"));
    // Later, text dragged in from elsewhere crosses a row and is dropped into one of its inputs.
    const text = dragData({ "text/plain": "1550" });
    const over = dragOver(env, 2, text("protected"));
    expect(over.preventDefault).not.toHaveBeenCalled(); expect(over.dataTransfer.dropEffect).toBe("");
    const dropped = drop(env, 2, text("read-only"));
    expect(dropped.preventDefault).not.toHaveBeenCalled();
    expect(env.move).not.toHaveBeenCalled();
  });
  it("a handle drag whose row is gone names no row here: its drop is still the table's, and nothing moves", () => {
    const data = dragData(); const env = tableEnv();
    // A save settling mid-drag re-keys the dragged new step's row to its saved id.
    dragStart(env, { ...three[2], clientId: "new:0b8f4e21-9c3a-4d67-a5f1-3e2d7c9b8a60", stepId: null }, data("read/write")); decoy(data, "a");
    const dropped = drop(env, 1, data("read-only"));
    expect(dropped.preventDefault).toHaveBeenCalledTimes(1);
    expect(env.move).not.toHaveBeenCalled();
  });
  it("a handle drag from another table is not this one's to move, even when it names a row here: the same part open in another window files the same saved ids (#366)", () => {
    const data = dragData(); const here = tableEnv(); const there = tableEnv({ dragScope: OTHER });
    dragStart(there, three[1], data("read/write")); decoy(data, "a");
    // The payload is unreadable over a row, so the row accepts the drag as a move...
    const over = dragOver(here, 0, data("protected"));
    expect(over.preventDefault).toHaveBeenCalledTimes(1); expect(over.dataTransfer.dropEffect).toBe("move");
    // ...and at the drop reads the other table's token: nothing moves, and the drop is still prevented.
    const dropped = drop(here, 0, data("read-only"));
    expect(dropped.preventDefault).toHaveBeenCalledTimes(1);
    expect(here.move).not.toHaveBeenCalled();
  });
  it("the token is the mount's, drawn once: a token drawn per render would turn a same-table drag that spans a re-render into a silent no-op (#366)", () => {
    // `tableEnv` binds `dragScope` directly, so the executed handlers cannot see how long it lives;
    // the declaration can.
    const declarations = nodes(tableSource, (n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name)
      && n.name.elements.some(e => ts.isBindingElement(e) && e.name.getText(tableSource) === "dragScope"));
    expect(declarations).toHaveLength(1);
    const { name, initializer } = declarations[0];
    expect((name as ts.ArrayBindingPattern).elements).toHaveLength(1);
    expect(initializer && ts.isCallExpression(initializer) && initializer.expression.getText(tableSource)).toBe("useState");
    expect((initializer as ts.CallExpression).arguments.map(a => a.getText(tableSource))).toEqual(["newId"]);
  });
  it("Alt + ↑ / ↓ on the handle moves its step one place; the arrows alone do nothing", () => {
    const keyDown = (key: string, altKey: boolean) => {
      const env = { move: vi.fn(), index: 1 }; const e = event({ key, altKey });
      handler<(e: unknown) => void>(isHandle, "onKeyDown", env)(e);
      return { move: env.move, prevented: e.preventDefault.mock.calls.length };
    };
    const up = keyDown("ArrowUp", true); expect(up.move).toHaveBeenCalledWith(1, 0); expect(up.prevented).toBe(1);
    const down = keyDown("ArrowDown", true); expect(down.move).toHaveBeenCalledWith(1, 2); expect(down.prevented).toBe(1);
    const plain = keyDown("ArrowUp", false); expect(plain.move).not.toHaveBeenCalled(); expect(plain.prevented).toBe(0);
  });
});
