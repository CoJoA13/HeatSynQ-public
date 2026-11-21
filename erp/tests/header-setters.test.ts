// The six guard pages' header boxes type through a pure `patchDraft` (#574).
//
// What this proves. Each of the 31 header boxes on the six pages that apply server payloads through
// the edit guard (the order hub, the saved shipment, the invoice, the cert, the customer page and
// Accounting) has an `onChange` that calls the page's `patchDraft` with the typed text under the
// box's own key, once, and never the page's setter with an object built from the render's copy.
// And each page's `patchDraft` is FUNCTIONAL: it hands the setter an updater that reads only
// its parameter, so a server payload the guard's own updater landed beside the keystroke is kept
// (the updater's output over `applyPayload`'s output shows the typed text and the payload's other
// fields). The hub's case goes through `capturePayload` + `keepTravelerPrinted`, the hub's own
// composed shape, and its local `travelerPrinted` true survives the keystroke (#550's residual).
// The demonstration half beside each updater case shows the mechanism it closes: the OBJECT form,
// `{ ...render, k: "typed" }`, applied in the same order replaces the state outright, so the
// payload's other fields are lost.
//
// And the customer page's eight keyed list cells (five address fields, three contact fields), whose
// setters are fed through `applyRows`, each hand that setter an updater over the rows alone: the
// handler reads the typed text first, and the updater sets that one field of the row whose id it
// closed over and nothing of any other row. The event's value is moved after the handler returns
// and before the updater runs, as a replayed updater would find the live input, so an updater that
// read the event itself shows the moved value and fails (owner ruling 5, 2026-10-20: fixed here).
//
// What it does not prove. React's update queue is not run: the apply order here (the payload's
// updater, then the keystroke's) is the order React applies two dispatches in, and the result of a
// non-functional action is that action, which is what the demonstration half states by hand. Nor
// does this file pin the rule across `src/`: tests/functional-setter-sweep.test.ts does, and it
// derives every `patchDraft` `onChange` in a guard-calling file and holds that set to the site list
// (tests/helpers/header-setter-sites.ts, hand-written, 31 rows, each a tag found by the key its
// `onFocus` registers with the guard), and every `onChange` there that calls a guard-fed setter
// itself, held to the keyed-cell list beside it (8 rows, each found by its `noteFocusCell`).
//
// vitest has no DOM, so each handler and each `patchDraft` is lifted from the page's own source and
// run over a hand-built environment (tests/helpers/source-lift.ts says why). The function under
// test is the one the page runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { makeEditGuard } from "@/lib/use-edit-guard";
import { keepTravelerPrinted } from "@/lib/traveler-printed";
import { all, run } from "./helpers/source-lift";
import { jsxTags, type JsxTag } from "./helpers/jsx-source";
import {
  COMPUTED_KEY_IDENTIFIER, HEADER_SETTER_PAGES, KEYED_CELL_PAGES, keyedCellFocus,
  type HeaderSetterPage as Page, type KeyedCellPage,
} from "./helpers/header-setter-sites";

const ERP_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** A change event carrying only what a handler reads: the target's current value. */
const ev = (value: string) => ({ target: { value } });

const PAGES: Page[] = HEADER_SETTER_PAGES;

/** The one input, textarea or select of `page` whose `onFocus` is `focus`. Fails, naming it, when
 *  there is none or more than one: a reader that finds nothing must fail the test, not pass it. */
function boxFocusedBy(page: Page | KeyedCellPage, focus: string): JsxTag {
  const found = jsxTags(page.file)
    .filter((tag) => ["input", "textarea", "select"].includes(tag.name) && tag.attr("onFocus") === focus);
  expect(found.map((tag) => tag.text), `${page.file}: the box whose onFocus is ${focus}`).toHaveLength(1);
  return found[0];
}

/** The one `patchDraft` function declared in `page`'s file, as source text. */
function patchDraftSource(page: Page): string {
  const path = join(ERP_ROOT, page.file);
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = all(file, ts.isFunctionDeclaration).filter((f) => f.name?.text === "patchDraft");
  expect(found, `${page.file}: one function declaration named patchDraft`).toHaveLength(1);
  return found[0].getText(file);
}

/** What React does with one dispatched action over a state: an updater is applied, an object
 *  replaces. The demonstration half's reading of the queue; nothing of React runs here. */
const applied = <T,>(state: T, action: T | ((cur: T) => T)): T =>
  typeof action === "function" ? (action as (cur: T) => T)(state) : action;

const SITES = PAGES.flatMap((page) => page.keys.map((entry) => {
  const key = typeof entry === "string" ? entry : entry.key;
  const computed = typeof entry !== "string";
  return { page, key, computed, focus: computed ? page.focus("KEY").replace('"KEY"', COMPUTED_KEY_IDENTIFIER) : page.focus(key) };
}));

describe("each header box types through the page's patchDraft", () => {
  it("lists #574's 30 sites and #588's Invoice folder box", () => {
    expect(SITES).toHaveLength(31);
  });

  it.each(SITES.map((site) => [site.page.file, site.focus, site] as const))(
    "%s: the box focused by %s calls patchDraft once with its key and the typed text, and never the setter",
    (_file, _focus, site) => {
      const tag = boxFocusedBy(site.page, site.focus);
      const onChange = tag.attr("onChange");
      expect(onChange, "an onChange").toBeDefined();
      const patchDraft = vi.fn();
      const setter = vi.fn();
      const render = { [site.key]: "old", other: "o0" };
      const environment: Record<string, unknown> = {
        patchDraft, [site.page.state]: render, [site.page.setter]: setter,
        ...(site.computed ? { key: site.key } : {}),
      };
      const handler = run<(e: unknown) => void>(onChange!, environment);
      handler(ev("typed"));
      expect(patchDraft.mock.calls).toEqual([[{ [site.key]: "typed" }]]);
      // The page's setter is never called from a keystroke: only patchDraft reaches it.
      expect(setter).not.toHaveBeenCalled();
    },
  );
});

const KEYED_CELL_SITES = KEYED_CELL_PAGES.flatMap((page) =>
  page.fields.map((field) => ({ page, field, focus: keyedCellFocus(page, field) })));

describe("each keyed list cell hands its applyRows-fed setter an updater over the rows alone", () => {
  it("lists the eight cells the brief names", () => {
    expect(KEYED_CELL_SITES).toHaveLength(8);
  });

  it.each(KEYED_CELL_SITES.map((site) => [site.page.file, site.focus, site] as const))(
    "%s: the cell focused by %s sets that field of its row from the text read in the handler, and touches no other row",
    (_file, _focus, site) => {
      const tag = boxFocusedBy(site.page, site.focus);
      const onChange = tag.attr("onChange");
      expect(onChange, "an onChange").toBeDefined();
      const setter = vi.fn();
      const row = { id: "row-1" };
      // The handler closes over the list's row (`a` or `ct`) for its id, and over its setter; the
      // rows' render copy is deliberately absent, so an updater that named it would throw.
      const handler = run<(e: unknown) => void>(onChange!, { [site.page.setter]: setter, [site.page.row]: row });
      const e = ev("typed");
      handler(e);
      expect(setter).toHaveBeenCalledOnce();
      const updater = setter.mock.calls[0][0] as (cur: Record<string, string>[]) => Record<string, string>[];
      expect(typeof updater, "the setter received an updater").toBe("function");

      // The input has moved on by the time the updater runs (a replay, a rebased lane): an updater
      // that reads the event finds "later"; the page's reads the text its handler read.
      e.target.value = "later";
      const rows = [
        { id: "row-1", [site.field]: "old", other: "o0" },
        { id: "row-2", [site.field]: "old2", other: "o1" },
      ];
      expect(updater(rows)).toEqual([
        { id: "row-1", [site.field]: "typed", other: "o0" },
        { id: "row-2", [site.field]: "old2", other: "o1" },
      ]);
      expect(rows[0][site.field], "the updater copies, never writes the rows it was given").toBe("old");
    },
  );
});

describe("each page's patchDraft is functional over the guard's own updater", () => {
  const others = PAGES.filter((page) => page.state !== "order");

  it.each(others.map((page) => [page.file, page] as const))("%s", (_file, page) => {
    const setter = vi.fn();
    const render = { k: "old", other: "o0" };
    const patchDraft = run<(patch: object) => void>(patchDraftSource(page), { [page.setter]: setter, [page.state]: render });
    patchDraft({ k: "typed" });
    expect(setter).toHaveBeenCalledOnce();
    const typed = setter.mock.calls[0][0] as (cur: object | null) => object | null;
    expect(typeof typed, "the setter received an updater").toBe("function");

    // The box on `k` is focused and untouched; a payload lands beside the keystroke. The guard's
    // updater first (the payload, dispatched before the keystroke), then the keystroke's.
    const g = makeEditGuard();
    g.onFocusField("k")(ev("old") as never);
    const payload = { k: "old", other: "o1" };
    const afterPayload = applied<object | null>(render, g.applyPayload(payload));
    expect(afterPayload).toEqual(payload);
    expect(applied(afterPayload, typed)).toEqual({ k: "typed", other: "o1" });

    // Nothing to patch before the first load: the updater keeps null.
    expect(typed(null)).toBeNull();

    // The demonstration half: the object form, built from the render's copy, applied in the same
    // order replaces the state outright, and the payload's `other` is gone until the next payload.
    const objectForm = { ...render, k: "typed" };
    expect(applied<object | null>(afterPayload, objectForm)).toEqual({ k: "typed", other: "o0" });
  });

  it("the order hub: a travelerPrinted true that onPrinted set after the render survives the keystroke because patchDraft is functional", () => {
    const page = PAGES[0];
    expect(page.state).toBe("order");
    // `travelerPrinted` is out of patchDraft's reach by type (#550: only keepTravelerPrinted and onPrinted write it).
    expect(patchDraftSource(page)).toContain('Partial<Omit<OrderDetail, "travelerPrinted">>');
    const setOrder = vi.fn();
    // The render the keystroke's handler closed over predates the print: false.
    const render = { k: "old", other: "o0", travelerPrinted: false };
    const patchDraft = run<(patch: object) => void>(patchDraftSource(page), { setOrder, order: render });
    patchDraft({ k: "typed" });
    expect(setOrder).toHaveBeenCalledOnce();
    const typed = setOrder.mock.calls[0][0] as (cur: typeof render | null) => typeof render | null;
    expect(typeof typed, "the setter received an updater").toBe("function");
    // onPrinted lands true (orders/[id]/page.tsx: `setOrder(o => o === null ? o : { ...o, travelerPrinted: true })`,
    // retyped; order-summary-wiring.test.ts pins its wiring), then a read computed before the print says false and
    // keepTravelerPrinted keeps the page's true, then the keystroke.
    const printed = applied<typeof render | null>(render, (o) => (o === null ? o : { ...o, travelerPrinted: true }));
    const g = makeEditGuard();
    g.onFocusField("k")(ev("old") as never);
    const fresh = { k: "old", other: "o1", travelerPrinted: false };
    const captured = g.capturePayload(fresh);
    const afterPayload = applied(printed, (prev) => captured.merge(prev, keepTravelerPrinted(prev, fresh)));
    expect(afterPayload).toEqual({ k: "old", other: "o1", travelerPrinted: true });
    expect(applied(afterPayload, typed)).toEqual({ k: "typed", other: "o1", travelerPrinted: true });
    expect(typed(null)).toBeNull();
    // The object form, built from the render that predates the print, loses the payload's `other` AND the local true.
    expect(applied<typeof render | null>(afterPayload, { ...render, k: "typed" })).toEqual({ k: "typed", other: "o0", travelerPrinted: false });
  });
});
