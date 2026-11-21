import type { ComponentProps, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineDecimalBox } from "@/components/InlineDecimalBox";
import { InlinePairBox } from "@/components/InlinePairBox";
import { InlineTextBox } from "@/components/InlineTextBox";
import { ReferenceTable } from "@/components/ReferenceTable";
import { ApiError } from "@/lib/fetcher";
import { REFERENCE_EXTRA_FIELDS, REFERENCE_KINDS, type ReferenceKind } from "@/lib/reference-constants";

// Pick lists: the edit box on an existing container type's Tare each (the weights design §9.4,
// "Pick lists", and §9.9 point 17). What leaving the box SENDS is the leaf's, proven in
// reference-inline-edit.test.ts. This file proves the box asks the leaf and keeps its three rules,
// and that the table draws the box on container types' tare each and on nothing else, sends its
// save as one key to the row's own route, and tells History before it reloads. It also proves
// the two failures apart (§9.9 point 24, owner 2026-10-09): a refusal the server answered reloads
// nothing, and a save with no answer reloads the table. And it proves that a reload reads Show
// inactive as it is when the read starts, so a save or an Active change that reloads after the box
// is clicked reads the click's setting, and that the Show inactive box reads the list again itself
// (#495 item 1). And it proves that a save the server answered 2xx puts the figure it sent into its
// row before the reload, so after Enter, a stored save and a failed reload, leaving the box sends
// nothing more, and that no other answer writes the figure into a row (#495 item 2). And that it
// writes nothing over the rows a read put into the table while the save was out, while a read
// dropped for a newer one counts for nothing (Codex P2 on #559).
//
// vitest runs in "node" with no DOM, so nothing here is clicked or typed. Three seams reach what a
// static render cannot, each with a precedent:
// - `useState` (lines-section-offer.test.tsx): the table's rows arrive from a read in an effect, and
//   a static render runs no effect, so rows are put in through the state that holds them. Their
//   setter records each write a handler makes (`seen.rowWrites`), and `held` applies those writes
//   in order, so a later render is handed the rows the table would hold by then. The same seam
//   hands one null state a recording setter, so a handler's `setText` or `setError` is seen.
// - A wrapper round the real box (shipment-lines-offer.test.tsx): it records the props the box was
//   handed and the element it returned. The real box renders. A handler taken from that element
//   still runs after the render has returned: on the server a state setter then does nothing, and a
//   ref is an ordinary object.
// - `api` and `invalidateHistory` write to one log, so the order of a save's steps is read by value.
// The handlers that are not the box's are reached through a probe (`addRow`, `probeTable`): the
// table is called as a function inside a render of a probe, so its hooks run in that render and the
// element tree comes back to be read. Every handler taken from one probe render closes over that
// render's hooks, so they share one ref. A box element in that tree is read for its props and is
// not rendered.

/**
 * `rows`: the only state in the rendered tree that starts as an array is the table's rows.
 * `nth`: the Nth `useState(null)` of one render answers `[value, set]`. In a render of the box
 * alone the first is the box's text. In a render of the table the second is the page's line, which
 * the list read owns, the fifth a row's message and the sixth the Add row's (P6 step 5d; the first
 * is the open History row, the third the blocker list, the fourth the pick lists' read). A case
 * that leans on it also asserts something only that state can put on screen.
 */
const seam = vi.hoisted(() => ({
  rows: null as unknown[] | null,
  nth: 0, value: null as unknown, set: (() => {}) as (next: unknown) => void, count: 0,
  permissions: [] as string[],
  // The table's Add-row draft: the first `useState({})` of a render. `null` leaves it alone.
  draft: null as Record<string, string> | null, setDraft: (() => {}) as (next: unknown) => void, plain: 0,
  // The discount boxes' typed text: the second `useState({})` of a render. `null` leaves it alone.
  pair: null as Record<string, unknown> | null, setPair: (() => {}) as (next: unknown) => void, plainPair: 0,
}));
vi.mock("react", async (original) => {
  const real = await original<typeof import("react")>();
  // The rows' setter: what a handler writes into the rows is recorded with the log's length when
  // it was written, and the log itself is not written. `seen` is read when it is called.
  const recordRows = (next: unknown) => { seen.rowWrites.push({ at: seen.log.length, next }); };
  return { ...real, useState: (initial: unknown) => {
    const state = real.useState(initial);
    if (Array.isArray(initial) && seam.rows !== null) return [seam.rows, recordRows];
    if (seam.pair !== null && initial !== null && typeof initial === "object" && !Array.isArray(initial)
        && ++seam.plainPair === 2) return [seam.pair, seam.setPair];
    if (seam.draft !== null && initial !== null && typeof initial === "object" && !Array.isArray(initial)
        && ++seam.plain === 1) return [seam.draft, seam.setDraft];
    if (initial === null && seam.nth !== 0 && ++seam.count === seam.nth) return [seam.value, seam.set];
    return state;
  } };
});

type BoxProps = Parameters<typeof import("@/components/InlineDecimalBox").InlineDecimalBox>[0];
const seen = vi.hoisted(() => ({
  boxes: [] as { props: unknown; element: unknown }[],
  log: [] as string[],
  rowWrites: [] as { at: number; next: unknown }[],
  put: (async () => ({ ok: true })) as () => Promise<unknown>,
  get: (async () => []) as () => Promise<unknown>,
  unsaved: [] as [boolean, string][],
}));
vi.mock("@/lib/use-unsaved-section", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/use-unsaved-section")>(),
  useUnsavedSection: (dirty: boolean, label: string) => { seen.unsaved.push([dirty, label]); },
}));
// The real box renders. The wrapper only records what it was handed and what it returned.
vi.mock("@/components/InlineDecimalBox", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/InlineDecimalBox")>();
  return { ...real, InlineDecimalBox: (props: BoxProps) => {
    const element = real.InlineDecimalBox(props);
    seen.boxes.push({ props, element });
    return element;
  } };
});
vi.mock("@/lib/use-permissions", () => ({ usePermissions: () => ({ permissions: seam.permissions, error: null }) }));
// Every request is logged as "METHOD path body". A PUT answers what `seen.put` answers. A read
// answers what `seen.get` answers: no rows, unless a case makes the reload fail.
vi.mock("@/lib/fetcher", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/fetcher")>(),
  api: async (path: string, init?: RequestInit) => {
    seen.log.push(`${init?.method ?? "GET"} ${path}${typeof init?.body === "string" ? ` ${init.body}` : ""}`);
    return init?.method === "PUT" ? seen.put() : seen.get();
  },
}));
vi.mock("@/components/HistoryPanel", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/HistoryPanel")>(),
  invalidateHistory: () => { seen.log.push("invalidateHistory"); },
}));

afterEach(() => {
  seen.boxes = []; seen.log = []; seen.rowWrites = []; seen.put = async () => ({ ok: true }); seen.get = async () => [];
  seam.rows = null; seam.nth = 0; seam.draft = null; seam.plain = 0; seam.pair = null; seam.plainPair = 0;
  seen.unsaved = [];
});

type InputProps = ComponentProps<"input">;
type Input = ReactElement<InputProps>;
/** The input a box returned, inside the row that holds it and its Saved mark. */
const inputIn = (element: ReactElement<{ children: unknown[] }>) => element.props.children[0] as Input;
const boxes = () => (seen.boxes as { props: BoxProps; element: ReactElement<{ children: unknown[] }> }[])
  .map(({ props, element }) => ({ props, element: inputIn(element) }));

type FocusOf = Parameters<NonNullable<InputProps["onFocus"]>>[0];
type ChangeOf = Parameters<NonNullable<InputProps["onChange"]>>[0];
type KeyOf = Parameters<NonNullable<InputProps["onKeyDown"]>>[0];
// What a browser does to the box, as the events its handlers read.
const focus = (input: Input) => input.props.onFocus?.({} as unknown as FocusOf);
const typeIn = (input: Input, value: string) => input.props.onChange?.({ target: { value } } as unknown as ChangeOf);
const leave = (input: Input, value: string) => input.props.onBlur?.({ target: { value } } as unknown as FocusOf);
const press = (input: Input, key: string, value: string) =>
  input.props.onKeyDown?.({ key, currentTarget: { value } } as unknown as KeyOf);
/** One turn of the event loop: every promise a handler was waiting on has been answered. */
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

const STEEL = "Tare each (lb) for Steel Basket";

/** One box rendered alone. `text` is what was typed, or null for a box nobody typed in. */
function box(over: Partial<BoxProps> = {}, text: string | null = null) {
  const setText = vi.fn();
  seam.nth = 1; seam.value = text; seam.set = setText; seam.count = 0;
  seen.boxes = [];
  const props: BoxProps = { label: STEEL, stored: "42.5", disabled: false, onSave: async () => true, ...over };
  try {
    const html = renderToStaticMarkup(<InlineDecimalBox {...props} />);
    expect(boxes()).toHaveLength(1);
    const input = boxes()[0].element;
    expect(input.type).toBe("input");
    return { html, input, setText };
  } finally {
    seam.nth = 0;
  }
}

describe("InlineDecimalBox: what it draws", () => {
  it("is one input named by its label, showing the stored figure, and nothing else", () => {
    const { html } = box();
    expect(html.match(/<[a-z]+\b/g)).toEqual(["<div", "<input"]);
    expect(html).toContain(`aria-label="${STEEL}"`);
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain('value="42.5"');
    // The attribute, not the word: the class list names `disabled:` whether or not the box is.
    expect(html).not.toContain(' disabled=""');
    expect(html).not.toContain("title=");
  });

  it("shows a stored figure as text, a stored 0 included, and nothing stored as blank", () => {
    expect(box({ stored: 310 }).html).toContain('value="310"');
    expect(box({ stored: 0 }).html).toContain('value="0"');
    expect(box({ stored: null }).html).toContain('value=""');
    expect(box({ stored: undefined }).html).toContain('value=""');
  });

  it("is disabled with the reason it was handed", () => {
    const { html } = box({ disabled: true, title: "Requires admin.edit" });
    expect(html).toContain(' disabled=""');
    expect(html).toContain('title="Requires admin.edit"');
  });

  it("shows what was typed, a cleared box included, whatever figure is stored", () => {
    // The table reloads after every save and hands each box its row again. A box being typed in
    // keeps its text through that: only the seeded text can put 60 on screen here.
    expect(box({ stored: "42.5" }, "60").html).toContain('value="60"');
    expect(box({ stored: "99" }, "60").html).toContain('value="60"');
    expect(box({ stored: "42.5" }, "").html).toContain('value=""');
  });
});

describe("InlineDecimalBox: leaving it, and Enter", () => {
  it("holds each keystroke as the box's text", () => {
    const { input, setText } = box();
    typeIn(input, "6");
    expect(setText.mock.calls).toEqual([["6"]]);
  });

  it("sends what the leaf says when the box is left: a new figure as typed, a cleared box as null", async () => {
    const onSave = vi.fn(async () => true);
    const first = box({ onSave });
    focus(first.input); leave(first.input, " 60 ");
    expect(onSave.mock.calls).toEqual([["60"]]);
    await settle();
    const second = box({ onSave });
    focus(second.input); leave(second.input, "");
    expect(onSave.mock.calls).toEqual([["60"], [null]]);
    await settle();
  });

  it("sends nothing for the stored figure spelled another way, and the box takes the stored figure back when it is left", () => {
    const onSave = vi.fn(async () => true);
    const { input, setText } = box({ onSave });
    focus(input); leave(input, "42.50");
    expect(onSave).not.toHaveBeenCalled();
    expect(setText.mock.calls).toEqual([[null]]);
  });

  it("Enter saves in place and no other key does", async () => {
    const onSave = vi.fn(async () => true);
    const { input } = box({ onSave });
    focus(input); press(input, "Tab", "60"); press(input, "a", "60");
    expect(onSave).not.toHaveBeenCalled();
    press(input, "Enter", "60");
    expect(onSave.mock.calls).toEqual([["60"]]);
    await settle();
  });

  it("Enter that sends nothing leaves the text alone: the cursor is still in the box", () => {
    const { input, setText } = box();
    focus(input); press(input, "Enter", "42.50");
    expect(setText).not.toHaveBeenCalled();
  });

  it("sends one save while the first is out: Enter, then the blur that follows it, and the box takes the stored figure when that save is answered", async () => {
    let answer: (stored: boolean) => void = () => {};
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const { input, setText } = box({ onSave });
    focus(input); press(input, "Enter", "60"); leave(input, "60");
    expect(onSave.mock.calls).toEqual([["60"]]);
    expect(setText).not.toHaveBeenCalled();
    answer(true); await settle();
    expect(setText.mock.calls).toEqual([[null]]);
  });

  // Codex P2 on #864. Enter, more typing, then Tab, all before the first save lands.
  it("a box left with other text while a save is out sends that text once the save was stored", async () => {
    let answer: (stored: boolean) => void = () => {};
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const { input, setText } = box({ onSave });
    focus(input); press(input, "Enter", "60"); leave(input, "61"); await settle();
    expect(onSave.mock.calls).toEqual([["60"]]);
    answer(true); await settle();
    expect(onSave.mock.calls).toEqual([["60"], ["61"]]);
    expect(setText).not.toHaveBeenCalled();
    answer(true); await settle();
    expect(setText.mock.calls).toEqual([[null]]);
  });

  it("compares that text with the value the save stored: the figure from before it is a change", async () => {
    let answer: (stored: boolean) => void = () => {};
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const { input } = box({ onSave });
    focus(input); press(input, "Enter", "60"); leave(input, "42.5"); await settle();
    answer(true); await settle();
    expect(onSave.mock.calls).toEqual([["60"], ["42.5"]]);
    answer(true); await settle();
  });

  it("a save that was not stored sends nothing more, and the box takes the stored figure", async () => {
    let answer: (stored: boolean) => void = () => {};
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const { input, setText } = box({ onSave });
    focus(input); press(input, "Enter", "60"); leave(input, "61"); await settle();
    answer(false); await settle();
    expect(onSave.mock.calls).toEqual([["60"]]);
    expect(setText.mock.calls).toEqual([[null]]);
  });

  it("sends again once the first save has been answered", async () => {
    const onSave = vi.fn(async () => true);
    const { input } = box({ onSave });
    focus(input); press(input, "Enter", "60"); await settle();
    press(input, "Enter", "61");
    expect(onSave.mock.calls).toEqual([["60"], ["61"]]);
    await settle();
  });

  it("after a save that was stored: keeps the text while the cursor is in the box, takes the stored figure once it is not", async () => {
    const stays = box();
    focus(stays.input); press(stays.input, "Enter", "60"); await settle();
    expect(stays.setText).not.toHaveBeenCalled();
    const left = box();
    focus(left.input); leave(left.input, "60"); await settle();
    expect(left.setText.mock.calls).toEqual([[null]]);
  });

  it("a refused save puts the stored figure back, with the cursor still in the box", async () => {
    const { input, setText } = box({ onSave: async () => false });
    focus(input); press(input, "Enter", "-5"); await settle();
    expect(setText.mock.calls).toEqual([[null]]);
  });
});

const BASKETS = [
  { id: "ct-1", name: "Steel Basket", active: true, tareEach: "42.5" },
  { id: "ct-2", name: "Wire Basket", active: true, tareEach: null },
];
const EDITOR = ["admin.view", "admin.edit"];

const PAGE_LINE = 2;
const ROW_MESSAGE = 5;
const ADD_MESSAGE = 6;
/** The table rendered with these rows. `message`, when given, seeds the first row's message (or,
 *  with `slot`, the page's line) and records what the table sets it to. */
function table(kind: ReferenceKind, rows: unknown[],
  over: { permissions?: string[]; message?: string | null; slot?: typeof PAGE_LINE | typeof ROW_MESSAGE } = {}) {
  const setMessage = vi.fn();
  const slot = over.slot ?? ROW_MESSAGE;
  seam.rows = rows; seam.permissions = over.permissions ?? EDITOR;
  seam.nth = "message" in over ? slot : 0; seam.set = setMessage; seam.count = 0;
  seam.value = slot === ROW_MESSAGE && typeof over.message === "string"
    ? { rowId: (rows[0] as { id: string }).id, message: over.message } : over.message ?? null;
  seen.boxes = [];
  try {
    return { html: renderToStaticMarkup(<ReferenceTable kind={kind} />), setMessage };
  } finally {
    seam.rows = null; seam.nth = 0;
  }
}
/** What the table set the first row's message to, each write as the text it left on that row: a
 *  write naming another row fails the case, and an updater is applied to a message on that row. */
function rowSaid(setMessage: ReturnType<typeof vi.fn>, rowId = "ct-1"): (string | null)[] {
  return setMessage.mock.calls.map(([next]) => {
    const value = typeof next === "function" ? (next as (b: unknown) => unknown)({ rowId, message: "before" }) : next;
    if (value === null) return null;
    expect((value as { rowId: string }).rowId).toBe(rowId);
    return (value as { message: string }).message;
  });
}
/** `rows` with every write recorded so far applied in order, for a later render: a function is
 *  applied to the rows before it, as React applies an updater, and an array replaces them. */
function held(rows: unknown[]): unknown[] {
  return seen.rowWrites.reduce<unknown[]>((current, { next }) =>
    typeof next === "function" ? (next as (before: unknown[]) => unknown[])(current) : next as unknown[], rows);
}
/** Every `<tr>…</tr>` of the table's body, in order. */
function bodyRows(html: string): string[] {
  const body = /<tbody>(.*?)<\/tbody>/.exec(html);
  expect(body).not.toBeNull();
  return body![1].match(/<tr\b.*?<\/tr>/g) ?? [];
}
/** The opening tag of the one input with this accessible name. */
function named(html: string, label: string): string {
  const found = (html.match(/<input\b[^>]*>/g) ?? []).filter((tag) => tag.includes(`aria-label="${label}"`));
  expect(found, label).toHaveLength(1);
  return found[0];
}

describe("ReferenceTable: an existing container type's Tare each", () => {
  it("draws one box on each existing type, named for the type, holding its stored figure", () => {
    const rows = bodyRows(table("containerType", BASKETS).html);
    expect(rows).toHaveLength(3); // two types, then the add row
    expect(named(rows[0], "Tare each (lb) for Steel Basket")).toContain('value="42.5"');
    expect(named(rows[1], "Tare each (lb) for Wire Basket")).toContain('value=""');
    // Two boxes and no third: the add row keeps its own plain input.
    expect(boxes().map(({ props }) => [props.label, props.stored, props.disabled, props.title])).toEqual([
      ["Tare each (lb) for Steel Basket", "42.5", false, undefined],
      ["Tare each (lb) for Wire Basket", null, false, undefined],
    ]);
  });

  it("closes the box on the gate the Active box reads, with its reason", () => {
    const row = bodyRows(table("containerType", BASKETS, { permissions: ["admin.view"] }).html)[0];
    const tare = named(row, "Tare each (lb) for Steel Basket");
    expect(tare).toContain(' disabled=""');
    expect(tare).toContain('title="Requires admin.edit"');
    const active = (row.match(/<input\b[^>]*>/g) ?? []).filter((tag) => tag.includes('type="checkbox"'));
    expect(active).toHaveLength(1);
    expect(active[0]).toContain(' disabled=""');
    expect(active[0]).toContain('title="Requires admin.edit"');
    // And open, with no title, for someone who may edit.
    const open = named(bodyRows(table("containerType", BASKETS).html)[0], "Tare each (lb) for Steel Basket");
    expect(open).not.toContain(' disabled=""');
    expect(open).not.toContain("title=");
  });

  it("marks every text, number and decimal column editable, and no ref column (R18)", () => {
    const marked = Object.entries(REFERENCE_EXTRA_FIELDS)
      .flatMap(([kind, fields]) => fields.map((f) => [kind, f.key, f.kind, f.editable ?? false]));
    expect(marked.filter(([, , fieldKind, editable]) => editable !== ["text", "number", "decimal"].includes(fieldKind as string))
      .filter(([, , fieldKind]) => fieldKind !== "boolean")).toEqual([]);
    expect(marked.filter(([, , fieldKind]) => fieldKind === "ref").map(([kind]) => kind).sort()).toEqual(["inspectionCode", "paymentType"]);
    // And as drawn: Tare each is the one decimal box of its own, and a link column stays text.
    const drawn = REFERENCE_KINDS.map((kind) => {
      table(kind, [{ id: "r-1", name: "Row", active: true }]);
      return [kind, boxes().length];
    });
    expect(drawn).toEqual(REFERENCE_KINDS.map((kind) => [kind, kind === "containerType" ? 1 : 0]));
    expect(bodyRows(table("paymentType", [{ id: "p-1", name: "Check", active: true, glAccountName: "1000" }]).html)[0])
      .toContain('<td class="p-2">1000</td>');
  });
});

/** The boxes and pair boxes of one probe render, in the order drawn, with that render's handlers. */
function probeBoxes(kind: ReferenceKind, rows: unknown[], over: { pair?: Record<string, unknown>; permissions?: string[] } = {}) {
  const setMessage = vi.fn(); const setPair = vi.fn();
  seam.rows = rows; seam.permissions = over.permissions ?? EDITOR;
  seam.pair = over.pair ?? {}; seam.setPair = setPair; seam.plainPair = 0;
  seam.nth = ROW_MESSAGE; seam.value = null; seam.set = setMessage; seam.count = 0;
  let tree: unknown = null;
  function Probe() {
    tree = ReferenceTable({ kind });
    return null;
  }
  try {
    renderToStaticMarkup(<Probe />);
  } finally {
    seam.rows = null; seam.nth = 0; seam.pair = null;
  }
  type Box = { label: string; stored?: unknown; text?: string; hint?: string; multiline?: boolean; disabled: boolean;
    onSave: (value: string | null) => Promise<boolean>; onCommit: (value: string) => void; onType: (value: string) => void };
  const props = (type: unknown) => findNodes(tree, (node) => node.type === type).map((node) => node.props as unknown as Box);
  const text = (label: string) => {
    const found = props(InlineTextBox).find((box) => box.label === label);
    expect(found, label).toBeDefined();
    return found!;
  };
  const pair = (label: string) => {
    const found = props(InlinePairBox).find((box) => box.label === label);
    expect(found, label).toBeDefined();
    return found!;
  };
  return { text, pair, setMessage, setPair, pairs: () => props(InlinePairBox) };
}

describe("ReferenceTable: a row's Name and its text and number columns (R18, #680)", () => {
  const GL = [{ id: "g-1", name: "4000", active: true, description: "Sales" }];
  const SPEC = [{ id: "s-1", name: "AMS 2750", active: true, text: "Two\nlines" }];
  const TERMS = [{ id: "t-1", name: "Net 30", active: true, netDays: 30, discountPercent: null, discountDays: null }];

  it("every kind's Name is a box named for its row, under that list's own name for the column", () => {
    expect(named(bodyRows(table("glAccount", GL).html)[0], "Account number for 4000")).toContain('value="4000"');
    expect(named(bodyRows(table("containerType", BASKETS).html)[0], "Name for Steel Basket")).toContain('value="Steel Basket"');
  });

  it("closes each box on the Active box's gate, with its reason", () => {
    const row = bodyRows(table("glAccount", GL, { permissions: ["admin.view"] }).html)[0];
    for (const label of ["Account number for 4000", "Description for 4000"]) {
      expect(named(row, label)).toContain(' disabled=""');
      expect(named(row, label)).toContain('title="Requires admin.edit"');
    }
  });

  it("a rename PUTs the one key, tells History, then reloads", async () => {
    const { text } = probeBoxes("containerType", BASKETS);
    await expect(text("Name for Steel Basket").onSave("Steel Tote")).resolves.toBe(true);
    expect(seen.log).toEqual([
      'PUT /api/admin/reference/containerType/ct-1 {"name":"Steel Tote"}',
      "invalidateHistory",
      "GET /api/admin/reference/containerType",
    ]);
  });

  it("a name the server refuses shows under its row and answers false", async () => {
    const { text, setMessage } = probeBoxes("containerType", BASKETS);
    seen.put = async () => { throw new ApiError("A container type with that name already exists", 409); };
    await expect(text("Name for Steel Basket").onSave("Wire Basket")).resolves.toBe(false);
    expect(rowSaid(setMessage)).toEqual(["A container type with that name already exists"]);
  });

  it("a text column saves its one key; a Text column is a textarea, Description an input", async () => {
    const { text } = probeBoxes("glAccount", GL);
    await text("Description for 4000").onSave("Revenue");
    expect(seen.log[0]).toBe('PUT /api/admin/reference/glAccount/g-1 {"description":"Revenue"}');
    const { html } = table("specification", SPEC);
    expect(html).toContain('<textarea aria-label="Text for AMS 2750"');
    expect(html).toContain("Two\nlines</textarea>");
    expect(named(bodyRows(table("glAccount", GL).html)[0], "Description for 4000")).toContain("<input");
  });

  it("every Text column is a textarea, so leaving it cannot drop a stored line break", () => {
    const texts = Object.entries(REFERENCE_EXTRA_FIELDS).flatMap(([kind, fields]) =>
      fields.filter((f) => f.key === "text").map((f) => [kind, f.multiline]));
    expect(texts.sort()).toEqual([["commentSnippet", true], ["endingStatement", true], ["specification", true]]);
  });

  it("Net days is sent as a number, and the box's one sentence refuses anything else", async () => {
    const good = probeBoxes("terms", TERMS);
    await expect(good.text("Net days for Net 30").onSave("45")).resolves.toBe(true);
    expect(seen.log[0]).toBe('PUT /api/admin/reference/terms/t-1 {"netDays":45}');
    seen.log = [];
    for (const typed of ["1e2", "-1", null]) {
      const bad = probeBoxes("terms", TERMS);
      await expect(bad.text("Net days for Net 30").onSave(typed)).resolves.toBe(false);
      expect(rowSaid(bad.setMessage, "t-1")).toEqual(["Net days must be a whole number of at least 0."]);
    }
    expect(seen.log).toEqual([]);
  });
});

describe("ReferenceTable: Terms' discount boxes save as a pair (owner ruling 2026-11-02, #680)", () => {
  const OFF = { id: "t-1", name: "Net 30", active: true, netDays: 30, discountPercent: null, discountDays: null };
  const ON = { ...OFF, name: "2/10 Net 30", discountPercent: "2", discountDays: 10 };
  const PERCENT = "Discount % for Net 30"; const DAYS = "Discount days for Net 30";
  const puts = () => seen.log.filter((entry) => entry.startsWith("PUT "));
  /** The text the table holds after the writes `setPair` was handed, each a whole map. */
  const pairAfter = (setPair: ReturnType<typeof vi.fn>, start: Record<string, unknown> = {}) =>
    setPair.mock.calls.at(-1)?.[0] ?? start;

  it("one box filled holds its text and sends nothing", async () => {
    const { pair, setPair } = probeBoxes("terms", [OFF]);
    pair(PERCENT).onCommit("2"); await settle();
    expect(puts()).toEqual([]);
    expect(pairAfter(setPair)).toEqual({ "t-1": { discountPercent: "2" } });
  });

  it("the second box filled sends both in one PUT, Discount days as a number, then drops the text", async () => {
    const start = { "t-1": { discountPercent: "2" } };
    const { pair, setPair } = probeBoxes("terms", [OFF], { pair: start });
    pair(DAYS).onCommit("10"); await settle();
    expect(puts()).toEqual(['PUT /api/admin/reference/terms/t-1 {"discountPercent":"2","discountDays":10}']);
    expect(pairAfter(setPair, start)).toEqual({});
  });

  it("clearing both removes the discount; clearing one holds", async () => {
    const first = probeBoxes("terms", [ON]);
    first.pair("Discount % for 2/10 Net 30").onCommit(""); await settle();
    expect(puts()).toEqual([]);
    const second = probeBoxes("terms", [ON], { pair: { "t-1": { discountPercent: "" } } });
    second.pair("Discount days for 2/10 Net 30").onCommit(""); await settle();
    expect(puts()).toEqual(['PUT /api/admin/reference/terms/t-1 {"discountPercent":null,"discountDays":null}']);
  });

  it("a box the rule refuses names it, sends nothing, and goes back, and its partner keeps what was typed", async () => {
    const start = { "t-1": { discountPercent: "2", discountDays: "x" } };
    const { pair, setPair, setMessage } = probeBoxes("terms", [OFF], { pair: start });
    pair(DAYS).onCommit("x"); await settle();
    expect(puts()).toEqual([]);
    expect(rowSaid(setMessage, "t-1")).toEqual(["Discount days must be a whole number of at least 1."]);
    expect(pairAfter(setPair, start)).toEqual({ "t-1": { discountPercent: "2" } });
    const percent = probeBoxes("terms", [OFF]);
    percent.pair(PERCENT).onCommit("4%"); await settle();
    expect(rowSaid(percent.setMessage, "t-1")).toEqual(["Net 30, Discount %: enter a number without % or commas, such as 7.25."]);
  });

  it("sends one save while the first is out: Enter, then the blur that follows it", async () => {
    let answer: () => void = () => {};
    seen.put = () => new Promise<unknown>((resolve) => { answer = () => resolve({ ok: true }); });
    const { pair } = probeBoxes("terms", [OFF], { pair: { "t-1": { discountPercent: "2" } } });
    pair(DAYS).onCommit("10"); await settle();
    pair(DAYS).onCommit("10"); await settle();
    expect(puts()).toHaveLength(1);
    answer(); await settle();
  });

  // Codex P2 on #864. The cursor is usually on its way to the other box as the first box's save goes.
  it("a box typed in and left while the save is out is committed once it lands, over what it stored", async () => {
    let answer: () => void = () => {};
    seen.put = () => new Promise<unknown>((resolve) => { answer = () => resolve({ ok: true }); });
    const { pair } = probeBoxes("terms", [ON]);
    const days = pair("Discount days for 2/10 Net 30");
    pair("Discount % for 2/10 Net 30").onCommit("3"); await settle();
    days.onType("15"); days.onCommit("15"); await settle();
    expect(puts()).toEqual(['PUT /api/admin/reference/terms/t-1 {"discountPercent":"3","discountDays":10}']);
    answer(); await settle();
    expect(puts()).toEqual([
      'PUT /api/admin/reference/terms/t-1 {"discountPercent":"3","discountDays":10}',
      'PUT /api/admin/reference/terms/t-1 {"discountPercent":"3","discountDays":15}',
    ]);
    answer(); await settle();
  });

  // Codex P2 on #864. A save with no answer can have landed, so the row the handler holds may be
  // stale: replaying over it would send the old percent back.
  it("a box left while a save with no answer was out sends nothing more, and keeps its text", async () => {
    let fail: () => void = () => {};
    seen.put = () => new Promise<unknown>((_resolve, reject) => { fail = () => reject(new TypeError("Failed to fetch")); });
    const { pair, setPair } = probeBoxes("terms", [ON]);
    const days = pair("Discount days for 2/10 Net 30");
    pair("Discount % for 2/10 Net 30").onCommit("3"); await settle();
    days.onType("15"); days.onCommit("15"); await settle();
    fail(); await settle();
    expect(puts()).toHaveLength(1);
    expect(pairAfter(setPair)).toEqual({ "t-1": { discountDays: "15" } });
  });

  it("a box still being typed in when the save lands keeps its text, and nothing more is sent", async () => {
    let answer: () => void = () => {};
    seen.put = () => new Promise<unknown>((resolve) => { answer = () => resolve({ ok: true }); });
    const { pair, setPair } = probeBoxes("terms", [ON]);
    pair("Discount % for 2/10 Net 30").onCommit("3"); await settle();
    pair("Discount days for 2/10 Net 30").onType("15");
    answer(); await settle();
    expect(puts()).toHaveLength(1);
    expect(pairAfter(setPair)).toEqual({ "t-1": { discountDays: "15" } });
  });

  it("a refused save shows under its row and drops both boxes' text, so each shows the stored figure", async () => {
    const start = { "t-1": { discountPercent: "2" } };
    seen.put = async () => { throw new ApiError("an early-pay discount needs both a percent and a day count", 400); };
    const { pair, setPair, setMessage } = probeBoxes("terms", [OFF], { pair: start });
    pair(DAYS).onCommit("10"); await settle();
    expect(rowSaid(setMessage, "t-1")).toEqual(["an early-pay discount needs both a percent and a day count"]);
    expect(pairAfter(setPair, start)).toEqual({});
  });

  it("the box that waits carries the Add row's hint, and the empty one does not", () => {
    const { pair } = probeBoxes("terms", [OFF], { pair: { "t-1": { discountPercent: "2" } } });
    expect(pair(PERCENT).hint).toBe("needs Discount days too");
    expect(pair(DAYS).hint).toBeUndefined();
    expect(probeBoxes("terms", [OFF]).pair(PERCENT).hint).toBeUndefined();
  });

  it("registers as unsaved work while text differs from the stored figures, and not otherwise", () => {
    const dirty = (rows: unknown[], pair: Record<string, unknown>) => {
      seen.unsaved = [];
      probeBoxes("terms", rows, { pair });
      return seen.unsaved.at(-1);
    };
    expect(dirty([OFF], { "t-1": { discountPercent: "2" } })).toEqual([true, "Terms"]);
    expect(dirty([OFF], {})).toEqual([false, "Terms"]);
    expect(dirty([ON], { "t-1": { discountPercent: "2.00" } })).toEqual([false, "Terms"]);
    // A row the table no longer holds keeps nothing registered.
    expect(dirty([ON], { "t-9": { discountPercent: "5" } })).toEqual([false, "Terms"]);
  });
});

describe("the Saved mark beside an inline box (owner ruling R7, #680)", () => {
  /** A box rendered with this as the value its newest landed save carried. */
  function landed(value: string | null, over: Partial<BoxProps> = {}) {
    const setLanded = vi.fn();
    seam.nth = 2; seam.value = value; seam.set = setLanded; seam.count = 0;
    seen.boxes = [];
    const html = renderToStaticMarkup(<InlineDecimalBox label={STEEL} stored="42.5" disabled={false} onSave={async () => true} {...over} />);
    seam.nth = 0;
    return { html, setLanded };
  }
  const MARK = `aria-label="${STEEL} saved"`;

  it("shows while the box shows the value the save carried, its own re-spelling included", () => {
    expect(landed("42.50").html).toContain(MARK);
    expect(landed("60").html).not.toContain(MARK);
    expect(landed(null).html).not.toContain(MARK);
  });

  it("is set by a stored save, and not by one that was refused", async () => {
    const stored = landed(null);
    focus(boxes()[0].element); leave(boxes()[0].element, "60"); await settle();
    expect(stored.setLanded.mock.calls).toEqual([["60"]]);
    const refused = landed(null, { onSave: async () => false });
    focus(boxes()[0].element); leave(boxes()[0].element, "60"); await settle();
    expect(refused.setLanded).not.toHaveBeenCalled();
  });
});

describe("ReferenceTable: saving the box", () => {
  it("the seam lands on the row's message: a seeded sentence is shown under its own row only", () => {
    const rows = bodyRows(table("containerType", BASKETS, { message: "A seeded message" }).html);
    expect(rows[0]).toContain(">A seeded message</p>");
    expect(rows[1]).not.toContain("A seeded message");
    // The shared PanelMessage: one refusal to a line.
    expect(rows[0]).toMatch(/<p role="alert" class="[^"]*whitespace-pre-line[^"]*">A seeded/);
  });

  it("PUTs the one key to the row's own route, tells History, then reloads, and answers true", async () => {
    table("containerType", BASKETS);
    await expect(boxes()[0].props.onSave("60")).resolves.toBe(true);
    expect(seen.log).toEqual([
      'PUT /api/admin/reference/containerType/ct-1 {"tareEach":"60"}',
      "invalidateHistory",
      "GET /api/admin/reference/containerType",
    ]);
  });

  it("sends a cleared box as null, to its own row", async () => {
    table("containerType", BASKETS);
    await boxes()[1].props.onSave(null);
    expect(seen.log[0]).toBe('PUT /api/admin/reference/containerType/ct-2 {"tareEach":null}');
  });

  // The page checks the figure before it sends (the decimal-entry rule, #517). A refusal is the
  // row's name, then the label, then the rule's sentence: owner answer 2. It sends nothing and
  // reloads nothing, and the box then shows the stored figure again (§9.9 point 17).
  it.each<[string, string]>([
    ["-1", "Steel Basket, Tare each (lb): cannot be negative."],
    ["1.234", "Steel Basket, Tare each (lb): use at most 2 digits after the point."],
    ["12345678901", "Steel Basket, Tare each (lb): must be less than 10,000,000,000."],
    ["40 lb", "Steel Basket, Tare each (lb): enter a number without $ or commas, such as 0.36."],
  ])("a figure the rule refuses (%s) sends nothing, names the row, and answers false", async (typed, sentence) => {
    const { setMessage } = table("containerType", BASKETS, { message: null });
    await expect(boxes()[0].props.onSave(typed)).resolves.toBe(false);
    expect(seen.log).toEqual([]);
    expect(rowSaid(setMessage)).toEqual([sentence]);
  });

  it("a cleared box is no refusal: null is sent", async () => {
    const { setMessage } = table("containerType", BASKETS, { message: null });
    await expect(boxes()[0].props.onSave(null)).resolves.toBe(true);
    expect(seen.log[0]).toBe('PUT /api/admin/reference/containerType/ct-1 {"tareEach":null}');
    expect(rowSaid(setMessage)).toEqual([null]);
  });

  it("a save that was stored clears its row's message, and leaves another row's", async () => {
    const { setMessage } = table("containerType", BASKETS, { message: "An earlier refusal" });
    await boxes()[0].props.onSave("60");
    expect(rowSaid(setMessage)).toEqual([null]);
    expect(rowSaid(setMessage, "ct-2")).toEqual(["before"]);
  });

  it("a save writes nothing to the page's line, which the list read owns", async () => {
    const { setMessage } = table("containerType", BASKETS, { message: null, slot: PAGE_LINE });
    seen.put = async () => { throw new ApiError("Container type is in use.", 400); };
    await boxes()[0].props.onSave("5");
    expect(setMessage).not.toHaveBeenCalled();
  });

  // A refusal is any status the server answered below 500: a value it will not store (400), a
  // permission lost since the page loaded (403), a type deleted elsewhere (404). 499 is the highest
  // of them. It is the row that holds the line against a save with no answer, whose lowest status
  // is the 500 below.
  it.each<[number, string]>([
    [400, "Container type is in use."],
    [403, "Requires admin.edit"],
    [404, "Not found"],
    [499, "Request failed (499)"],
  ])("a refusal (%i) shows the server's sentence, tells History nothing, reloads nothing, and answers false", async (status, sentence) => {
    const { setMessage } = table("containerType", BASKETS, { message: null });
    seen.put = async () => { throw new ApiError(sentence, status); };
    await expect(boxes()[0].props.onSave("5")).resolves.toBe(false);
    expect(seen.log).toEqual(['PUT /api/admin/reference/containerType/ct-1 {"tareEach":"5"}']);
    expect(rowSaid(setMessage)).toEqual([sentence]);
  });

  // The design's §9.9 point 24, owner 2026-10-09. A save has no answer when the request threw
  // before a response arrived, or the server answered 5xx; since #547, also when it answered 2xx and
  // its body could not be read, after which the figure was stored. The figure may have been stored,
  // so the table is read again and the box shows what the server holds. 500 is the lowest status
  // that counts, and it is the one used here. 499, above, is the highest that does not.
  const SAVED_60_THEN_RELOADED = [
    'PUT /api/admin/reference/containerType/ct-1 {"tareEach":"60"}',
    "invalidateHistory",
    "GET /api/admin/reference/containerType",
  ];

  it.each<[string, Error]>([
    ["the request threw", new TypeError("Failed to fetch")],
    ["the server answered 500", new ApiError("Request failed (500)", 500)],
  ])("a save with no answer (%s) shows the transport's message, tells History, reloads the table, and answers false", async (_form, failure) => {
    const { setMessage } = table("containerType", BASKETS, { message: null });
    seen.put = async () => { throw failure; };
    await expect(boxes()[0].props.onSave("60")).resolves.toBe(false);
    expect(seen.log).toEqual(SAVED_60_THEN_RELOADED);
    // The message is set once and left: a reload that lands writes none.
    expect(rowSaid(setMessage)).toEqual([failure.message]);
  });

  it("a reload that fails after a save with no answer: the row keeps the transport's message, the page's line takes the reload's, and it still answers false", async () => {
    for (const slot of [ROW_MESSAGE, PAGE_LINE] as const) {
      seen.log = [];
      const { setMessage } = table("containerType", BASKETS, { message: null, slot });
      seen.put = async () => { throw new TypeError("Failed to fetch"); };
      seen.get = async () => { throw new ApiError("Request failed (503)", 503); };
      await expect(boxes()[0].props.onSave("60")).resolves.toBe(false);
      expect(seen.log).toEqual(SAVED_60_THEN_RELOADED);
      if (slot === ROW_MESSAGE) expect(rowSaid(setMessage)).toEqual(["Failed to fetch"]);
      else expect(setMessage.mock.calls).toEqual([["Request failed (503)"]]);
    }
  });

  // The wait for the reload, on both paths that reload. `saveExtra` answers the box only when
  // the table's read has landed. The box sends nothing more until it is answered, and once a read
  // has landed the `stored` it shows is the one that read brought. Each case holds the read open
  // and looks at the moment between: the read is out, and the box has no answer yet.
  /** Holds the table's next read open until `land()`, which answers it with no rows. */
  function heldRead() {
    let answerRead: (rows: unknown[]) => void = () => {};
    seen.get = () => new Promise<unknown>((resolve) => { answerRead = resolve; });
    return { land: () => answerRead([]) };
  }
  const READ = "GET /api/admin/reference/containerType";

  it("waits for the reload before it answers true: a save that was stored", async () => {
    table("containerType", BASKETS);
    const read = heldRead();
    const answers: boolean[] = [];
    const save = boxes()[0].props.onSave("60").then((stored) => { answers.push(stored); });
    await settle();
    expect(seen.log.at(-1)).toBe(READ);
    expect(answers).toEqual([]);
    read.land(); await save;
    expect(answers).toEqual([true]);
  });

  it("waits for the reload before it answers false: a save with no answer", async () => {
    table("containerType", BASKETS);
    seen.put = async () => { throw new TypeError("Failed to fetch"); };
    const read = heldRead();
    const answers: boolean[] = [];
    const save = boxes()[0].props.onSave("60").then((stored) => { answers.push(stored); });
    await settle();
    expect(seen.log.at(-1)).toBe(READ);
    expect(answers).toEqual([]);
    read.land(); await save;
    expect(answers).toEqual([false]);
  });
});

// The table's own handlers: the Add row's, the Show inactive box's and the Active box's. Each is
// reached by calling the table as a function inside a render of a probe, so the hooks run in the
// probe and the element tree comes back to be read.
type TreeNode = {
  type?: unknown;
  props?: {
    type?: unknown; children?: unknown;
    onClick?: () => unknown; onChange?: (event: unknown) => unknown; onSave?: BoxProps["onSave"];
  };
};
/** Every element of the tree that passes `test`, in the order the page draws them. */
function findNodes(node: unknown, test: (element: TreeNode) => boolean): TreeNode[] {
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, test));
  if (typeof node !== "object" || node === null) return [];
  const element = node as TreeNode;
  return [...(test(element) ? [element] : []), ...findNodes(element.props?.children, test)];
}
/** The first element of the tree that passes `test`, or null. */
function findNode(node: unknown, test: (element: TreeNode) => boolean): TreeNode | null {
  return findNodes(node, test)[0] ?? null;
}
/** The Add button's handler for `kind`, with the Add-row draft seeded. */
function addRow(kind: ReferenceKind, draft: Record<string, string>) {
  const setMessage = vi.fn(); const setDraft = vi.fn();
  seam.permissions = ["admin.view", "admin.create"]; seam.rows = [];
  seam.draft = draft; seam.setDraft = setDraft; seam.plain = 0;
  seam.nth = ADD_MESSAGE; seam.value = null; seam.set = setMessage; seam.count = 0;
  let added: TreeNode | null = null;
  function Probe() {
    added = findNode(ReferenceTable({ kind }), ({ type, props }) => type === "button" && props?.children === "Add");
    return null;
  }
  try {
    renderToStaticMarkup(<Probe />);
  } finally {
    seam.rows = null; seam.nth = 0;
  }
  expect(added).not.toBeNull();
  return { add: async () => { await (added as unknown as TreeNode).props!.onClick!(); }, setMessage, setDraft };
}

/** Three handlers taken from one render of the table, so all three share that render's hooks:
 *  the Show inactive box's onChange, the first row's Tare each box's save, and the first row's
 *  Active box's onChange, which answers with the save it starts. */
function probeTable(kind: ReferenceKind, rows: unknown[], permissions = EDITOR) {
  seam.rows = rows; seam.permissions = permissions;
  let tree: unknown = null;
  function Probe() {
    tree = ReferenceTable({ kind });
    return null;
  }
  try {
    renderToStaticMarkup(<Probe />);
  } finally {
    seam.rows = null;
  }
  const label = findNode(tree, ({ type, props }) =>
    type === "label" && Array.isArray(props?.children) && props.children.includes("Show inactive"));
  const toggle = findNode(label?.props?.children, ({ type }) => type === "input");
  // In the order drawn: Show inactive, then each row's Active box. Container types have no flag
  // column, and the Add row has no checkbox for them.
  const checkboxes = findNodes(tree, ({ type, props }) => type === "input" && props?.type === "checkbox");
  expect(checkboxes).toHaveLength(3);
  expect(checkboxes[0]).toBe(toggle);
  const tare = findNodes(tree, ({ type }) => type === InlineDecimalBox);
  expect(tare).toHaveLength(2);
  return {
    showInactive: (checked: boolean) => { toggle!.props!.onChange!({ target: { checked } }); },
    onSave: tare[0].props!.onSave!,
    active: () => checkboxes[1].props!.onChange!({}) as Promise<void>,
  };
}

describe("ReferenceTable: the Add row checks a decimal box before it posts", () => {
  it.each<[ReferenceKind, Record<string, string>, string]>([
    ["containerType", { name: "Tote", tareEach: "1.234" }, "Tare each (lb): use at most 2 digits after the point."],
    ["containerType", { name: "Tote", tareEach: "-1" }, "Tare each (lb): cannot be negative."],
    ["terms", { name: "2/10", discountPercent: "4%" }, "Discount %: enter a number without % or commas, such as 7.25."],
    // Ruling 19 (G5-4): a whole-number column is checked by its box too; `1e2` used to post 100.
    ["terms", { name: "Net 1e2", netDays: "1e2" }, "Net days must be a whole number of at least 0."],
    ["terms", { name: "2/0", discountPercent: "2", discountDays: "0" }, "Discount days must be a whole number of at least 1."],
  ])("%s %j posts nothing, says %j, and keeps the draft", async (kind, draft, sentence) => {
    const { add, setMessage, setDraft } = addRow(kind, draft);
    await add();
    expect(seen.log).toEqual([]);
    expect(setMessage.mock.calls).toEqual([[sentence]]);
    expect(setDraft).not.toHaveBeenCalled();
  });

  it("a figure the rule accepts, or a blank box, posts as it did", async () => {
    for (const tareEach of ["1.5", "", "  "]) {
      seen.log = [];
      const { add, setMessage } = addRow("containerType", { name: "Tote", tareEach });
      await add();
      expect(seen.log[0]).toMatch(/^POST \/api\/admin\/reference\/containerType /);
      expect(setMessage.mock.calls[0]).not.toEqual([expect.stringContaining("Tare each")]);
    }
  });

  it("a whole number the rule accepts posts as a number, with the spaces around it dropped (ruling 19)", async () => {
    seen.log = [];
    const { add, setMessage } = addRow("terms", { name: "Net 45", netDays: " 45 " });
    await add();
    expect(seen.log[0]).toMatch(/^POST \/api\/admin\/reference\/terms /);
    expect(seen.log[0]).toContain('"netDays":45');
    expect(setMessage.mock.calls[0]).not.toEqual([expect.stringContaining("Net days")]);
  });
  // #720: Add holds while its POST is out, so a second click sends nothing (a second row of the
  // same name would be refused once the first landed); the hold clears when the answer lands.
  it("a second Add while the POST is out sends nothing (#720)", async () => {
    seen.log = [];
    let land: () => void = () => {};
    seen.get = () => new Promise<unknown>((resolve) => { land = () => resolve({}); });
    const { add } = addRow("terms", { name: "Net 45" });
    const first = add();
    await add();
    expect(seen.log.filter((line) => line.startsWith("POST "))).toHaveLength(1);
    seen.get = async () => []; // the reload after the POST answers at once
    land();
    await first;
    await add();
    expect(seen.log.filter((line) => line.startsWith("POST "))).toHaveLength(2);
  });
});

const LIST = "GET /api/admin/reference/containerType";
const LIST_INACTIVE = "GET /api/admin/reference/containerType?includeInactive=1";
/** Holds the next PUT open until `answer()`, which answers it as stored. */
function heldPut() {
  let answerPut: () => void = () => {};
  seen.put = () => new Promise<unknown>((resolve) => { answerPut = () => resolve({ ok: true }); });
  return { answer: () => answerPut() };
}

// #495 item 1. A read takes the Show inactive setting as it is when the read starts, not as it was
// in the render that made the handler. The first three cases hold a PUT open, click the box while
// it is out, and then read the reload the save starts once it is answered. The last reads the
// box's own read.
describe("ReferenceTable: a reload reads Show inactive as it is when the read starts (#495 item 1)", () => {
  it("a Tare each save that began unticked and reloads after the box is ticked reads inactive rows too", async () => {
    const { showInactive, onSave } = probeTable("containerType", BASKETS);
    const put = heldPut();
    const save = onSave("60"); await settle();
    showInactive(true);
    put.answer();
    await expect(save).resolves.toBe(true);
    // The second entry is the box's own read, the fourth the save's.
    expect(seen.log).toEqual([
      'PUT /api/admin/reference/containerType/ct-1 {"tareEach":"60"}',
      LIST_INACTIVE,
      "invalidateHistory",
      LIST_INACTIVE,
    ]);
    await settle();
  });

  it("an Active change that began unticked and reloads after the box is ticked reads inactive rows too", async () => {
    const { showInactive, active } = probeTable("containerType", BASKETS);
    const put = heldPut();
    const flip = active(); await settle();
    showInactive(true);
    put.answer(); await flip;
    expect(seen.log).toEqual([
      'PUT /api/admin/reference/containerType/ct-1 {"active":false}',
      LIST_INACTIVE,
      "invalidateHistory",
      LIST_INACTIVE,
    ]);
    await settle();
  });

  it("ticked and then unticked while the save is out: the save's reload reads active rows only", async () => {
    const { showInactive, onSave } = probeTable("containerType", BASKETS);
    const put = heldPut();
    const save = onSave("60"); await settle();
    showInactive(true); showInactive(false);
    put.answer(); await save;
    expect(seen.log[0]).toBe('PUT /api/admin/reference/containerType/ct-1 {"tareEach":"60"}');
    expect(seen.log.slice(-2)).toEqual(["invalidateHistory", LIST]);
    await settle();
  });

  it("the Show inactive box reads the list again with its own setting", async () => {
    probeTable("containerType", BASKETS).showInactive(true);
    expect(seen.log).toEqual([LIST_INACTIVE]);
    await settle();
    seen.log = [];
    const fresh = probeTable("containerType", BASKETS);
    fresh.showInactive(true); fresh.showInactive(false);
    expect(seen.log).toEqual([LIST_INACTIVE, LIST]);
    await settle();
  });
});

// #495 item 2. A save the server answered 2xx puts the figure it sent into its row before the
// reload, through an updater, so a reload that fails leaves the row on the figure the server took.
// A later render is handed the rows the recorded writes yield (`held`), and its box's handlers are
// the ones used next. That models React's "the newest render's handler runs" rather than
// exercising it.
describe("ReferenceTable: a stored save puts the figure it sent into its row (#495 item 2)", () => {
  const PUT_60 = 'PUT /api/admin/reference/containerType/ct-1 {"tareEach":"60"}';
  const puts = () => seen.log.filter((entry) => entry.startsWith("PUT "));
  const reloadFails = () => { seen.get = async () => { throw new ApiError("Request failed (503)", 503); }; };

  it("writes the figure through an updater, after the PUT and History and before the reload, over the rows the table holds then", async () => {
    table("containerType", BASKETS);
    await expect(boxes()[0].props.onSave("60")).resolves.toBe(true);
    const [write] = seen.rowWrites;
    // Two entries were logged before it, the PUT and History, and the reload's GET is the third.
    expect(write.at).toBe(2);
    expect(seen.log[2]).toBe("GET /api/admin/reference/containerType");
    expect(typeof write.next).toBe("function");
    const apply = write.next as (rows: unknown[]) => unknown[];
    const fromBaskets = apply(BASKETS);
    expect(fromBaskets).toEqual([{ ...BASKETS[0], tareEach: "60" }, BASKETS[1]]);
    expect(fromBaskets[1]).toBe(BASKETS[1]);
    // Rows the table came to hold after the render that started the save: another figure on the
    // other row, and a third row. The write keeps both.
    const other = [BASKETS[0], { ...BASKETS[1], tareEach: "15" }, { id: "ct-3", name: "Tote", active: true, tareEach: "3" }];
    const fromOther = apply(other);
    expect(fromOther).toEqual([{ ...BASKETS[0], tareEach: "60" }, other[1], other[2]]);
    expect(fromOther[1]).toBe(other[1]);
    expect(fromOther[2]).toBe(other[2]);
  });

  /** Enter stores 60 on Steel Basket and the reload after it fails. Then the table renders again
   *  with the rows the save wrote. */
  async function enterThenFailedReload() {
    reloadFails();
    table("containerType", BASKETS);
    const input = boxes()[0].element;
    focus(input); press(input, "Enter", "60"); await settle();
    expect(puts()).toEqual([PUT_60]);
    return table("containerType", held(BASKETS));
  }

  it("after Enter, a stored save and a failed reload, leaving the box sends nothing more, and it shows the figure sent", async () => {
    const { html } = await enterThenFailedReload();
    leave(boxes()[0].element, "60"); await settle();
    expect(puts()).toEqual([PUT_60]);
    expect(named(html, STEEL)).toContain('value="60"');
  });

  it("after that, a changed figure is still sent", async () => {
    await enterThenFailedReload();
    leave(boxes()[0].element, "61"); await settle();
    expect(puts()).toEqual([PUT_60, 'PUT /api/admin/reference/containerType/ct-1 {"tareEach":"61"}']);
  });

  it("after that, the figure from before the save is a change, and is sent", async () => {
    await enterThenFailedReload();
    leave(boxes()[0].element, "42.5"); await settle();
    expect(puts()).toEqual([PUT_60, 'PUT /api/admin/reference/containerType/ct-1 {"tareEach":"42.5"}']);
  });

  it("after a read that lands with the figure from before the save, the figure sent is a change again, and is sent", async () => {
    // The reload brings 42.5 back, as it would after another writer put it back. The rows it
    // brought replace the figure the save wrote, so nothing remembers 60 as already stored.
    seen.get = async () => BASKETS;
    table("containerType", BASKETS);
    const input = boxes()[0].element;
    focus(input); press(input, "Enter", "60"); await settle();
    expect(named(table("containerType", held(BASKETS)).html, STEEL)).toContain('value="42.5"');
    leave(boxes()[0].element, "60"); await settle();
    expect(puts()).toEqual([PUT_60, PUT_60]);
  });

  it("a save stored on leaving the box, then a failed reload: the box shows the figure sent, and leaving it with that figure again sends nothing", async () => {
    reloadFails();
    table("containerType", BASKETS);
    const input = boxes()[0].element;
    focus(input); leave(input, "60"); await settle();
    expect(puts()).toEqual([PUT_60]);
    expect(named(table("containerType", held(BASKETS)).html, STEEL)).toContain('value="60"');
    const again = boxes()[0].element;
    focus(again); leave(again, "60"); await settle();
    expect(puts()).toEqual([PUT_60]);
  });

  it("after Enter clears the box, a stored save and a failed reload, the box shows no figure, and leaving it still blank sends nothing more", async () => {
    // A cleared box sends null, and null is the figure the row then holds: the blank box over no
    // figure is no change. Were the row left on 42.5, the blank box would send null again.
    const PUT_CLEARED = 'PUT /api/admin/reference/containerType/ct-1 {"tareEach":null}';
    reloadFails();
    table("containerType", BASKETS);
    const input = boxes()[0].element;
    focus(input); press(input, "Enter", ""); await settle();
    expect(puts()).toEqual([PUT_CLEARED]);
    expect(named(table("containerType", held(BASKETS)).html, STEEL)).toContain('value=""');
    leave(boxes()[0].element, ""); await settle();
    expect(puts()).toEqual([PUT_CLEARED]);
  });

  // Codex P2 on #559. A read that lands while the save is out puts rows into the table, and they
  // can hold a figure stored after this one (another admin's). The figure this save sent is not
  // written over them: the read that landed and the reload after the save decide. Only a read
  // whose rows were put into the table counts, not one dropped for a newer read. Each case holds
  // the PUT open, has the Show inactive box read while it is out, and fails the save's reload.
  describe("a read that lands while the save is out (Codex P2 on #559)", () => {
    const NEWER = [{ ...BASKETS[0], tareEach: "70" }, BASKETS[1]];

    it("keeps the figure that read brought: the save writes nothing over it, and the reload still runs", async () => {
      const { showInactive, onSave } = probeTable("containerType", BASKETS);
      const put = heldPut();
      const save = onSave("60"); await settle();
      seen.get = async () => NEWER;
      showInactive(true); await settle();
      reloadFails();
      put.answer();
      await expect(save).resolves.toBe(true);
      expect(seen.log).toEqual([PUT_60, LIST_INACTIVE, "invalidateHistory", LIST_INACTIVE]);
      // The only write is the rows the box's read brought, after the PUT and that read.
      expect(seen.rowWrites).toEqual([{ at: 2, next: NEWER }]);
      expect(named(table("containerType", held(BASKETS)).html, STEEL)).toContain('value="70"');
    });

    it("a read dropped for a newer one puts nothing into the table, so the figure sent is still written", async () => {
      const { showInactive, onSave } = probeTable("containerType", BASKETS);
      const put = heldPut();
      const save = onSave("60"); await settle();
      // Ticked, then unticked: two reads out. The first lands with 70 and is dropped, being older
      // than the second, which is still out when the PUT is answered.
      const answers: (() => Promise<unknown>)[] = [async () => NEWER, () => new Promise<unknown>(() => {})];
      seen.get = () => answers.shift()!();
      showInactive(true); showInactive(false); await settle();
      reloadFails();
      put.answer();
      await expect(save).resolves.toBe(true);
      expect(seen.log).toEqual([PUT_60, LIST_INACTIVE, LIST, "invalidateHistory", LIST]);
      expect(seen.rowWrites).toHaveLength(1);
      expect(typeof seen.rowWrites[0].next).toBe("function");
      expect(named(table("containerType", held(BASKETS)).html, STEEL)).toContain('value="60"');
    });
  });

  describe("nothing is written into a row when the figure is not known to be stored", () => {
    it("a figure the table's own check refuses", async () => {
      table("containerType", BASKETS);
      await expect(boxes()[0].props.onSave("-1")).resolves.toBe(false);
      expect(seen.rowWrites).toEqual([]);
    });

    it.each([400, 403, 404, 499])("a refusal the server answered (%i)", async (status) => {
      table("containerType", BASKETS);
      seen.put = async () => { throw new ApiError("Refused", status); };
      await expect(boxes()[0].props.onSave("60")).resolves.toBe(false);
      expect(seen.rowWrites).toEqual([]);
    });

    it.each<[string, Error]>([
      ["the request threw", new TypeError("Failed to fetch")],
      ["the server answered 500", new ApiError("Request failed (500)", 500)],
    ])("a save with no answer (%s): the reload's rows only, never the figure sent", async (_form, failure) => {
      table("containerType", BASKETS);
      seen.put = async () => { throw failure; };
      await expect(boxes()[0].props.onSave("60")).resolves.toBe(false);
      // After the PUT, History and the GET: the rows the read brought, which are none here.
      expect(seen.rowWrites).toEqual([{ at: 3, next: [] }]);
    });

    it("a save with no answer whose reload fails too", async () => {
      table("containerType", BASKETS);
      seen.put = async () => { throw new TypeError("Failed to fetch"); };
      reloadFails();
      await expect(boxes()[0].props.onSave("60")).resolves.toBe(false);
      expect(seen.rowWrites).toEqual([]);
    });
  });
});
