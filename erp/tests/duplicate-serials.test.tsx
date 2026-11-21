import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OrderLineCard, findDuplicateSerials } from "../src/app/orders/new/OrderLineCard";
import type { SerialDraft } from "../src/app/orders/new/order-draft";
import { ApiError } from "../src/lib/fetcher";
import { newId } from "../src/lib/client-id";
import { declared, jsxTags } from "./helpers/jsx-source";
import { all, run } from "./helpers/source-lift";

// A serial's repeats on one line, compared trimmed (#546, owner ruling 2026-10-18).
//
// The server trims each serial (`SERIAL_ITEM`, src/server/order-internals.ts) before it looks for
// a repeat, so `A` and `A ` are one serial to it. Both order screens read `findDuplicateSerials`:
// New order's card and Save, and the saved order's Serials grid. A serial blank after trimming is
// never a duplicate (owner answer 3): each screen refuses it as blank only.
//
// vitest has no DOM. OrderLineCard renders to static markup, so its row highlight is read from
// that. The saved order's Serials grid mounts a bulk grid and cannot be rendered here: its `save`,
// its `dupes` and its row's class are lifted out of its source and run, the way
// order-recovery-lifecycle.test.ts runs its `save`. New order's Save refusal is the lifted
// `validate` in order-entry-containers.test.tsx.

const serials = (...values: string[]): SerialDraft[] =>
  values.map((serial, i) => ({ id: `s${i + 1}`, serial, description: "" }));
const found = (...values: string[]) => [...findDuplicateSerials(serials(...values))];

describe("findDuplicateSerials", () => {
  it("compares serials trimmed and answers the trimmed value", () => {
    expect(found(" A", "A ")).toEqual(["A"]);
    expect(found("A", "A ")).toEqual(["A"]);
    expect(found("A-1", "B", "A-1")).toEqual(["A-1"]);
  });

  it("counts case: A and a are two serials", () => {
    expect(found("A", "a")).toEqual([]);
  });

  it("never answers a serial that is blank after trimming", () => {
    expect(found("", "  ")).toEqual([]);
    expect(found("", "")).toEqual([]);
    expect(found(" ", "A", "  ", "A ")).toEqual(["A"]);
  });
});

describe("New order's card: the duplicate rows", () => {
  const allowed = { allowed: true, disabled: false, title: undefined };
  function card(values: string[]): string {
    return renderToStaticMarkup(<OrderLineCard index={1} isLead={false} coordinatedProcess customerChosen
      customerId="fictional-customer" receivedDate={undefined} ordersViewAllowed partsGate={allowed}
      processesGate={allowed} quotePickGate={allowed} onChange={() => {}}
      line={{ id: "fictional-line", partId: null, qty: "30", weightOverride: null, serials: serials(...values) }} parts={[]} />);
  }
  /** The class of the row holding each serial's box, in the card's order. */
  const rowClasses = (html: string): string[] =>
    [...html.matchAll(/<div class="([^"]*)"><input id="entry-line-fictional-line-serial-s\d+"/g)].map(match => match[1]);

  it("marks every row whose serial repeats once trimmed, and names the trimmed value", () => {
    const html = card([" A", "B", "A "]);
    const rows = rowClasses(html);
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.includes("border-red-400"))).toEqual([true, false, true]);
    expect(html).toContain("Duplicate serial: A</p>");
  });

  it("marks no row for two blank serials", () => {
    const html = card(["", "  "]);
    const rows = rowClasses(html);
    expect(rows).toHaveLength(2);
    expect(rows.some(row => row.includes("border-red-400"))).toBe(false);
    expect(html).not.toContain("Duplicate serial");
  });
});

// ---- the saved order's Serials grid, lifted ----

const SERIALS_FILE = "src/app/orders/[id]/SerialsSection.tsx";
const serialsPath = fileURLToPath(new URL(`../${SERIALS_FILE}`, import.meta.url));
const serialsSource = ts.createSourceFile(serialsPath, readFileSync(serialsPath, "utf8"), ts.ScriptTarget.Latest, true,
  ts.ScriptKind.TSX);
function lifted(name: string): string {
  const functions = all(serialsSource, ts.isFunctionDeclaration).filter(f => f.name?.text === name);
  if (functions.length !== 1) throw new Error(`Expected one function ${name} in ${SERIALS_FILE}, found ${functions.length}`);
  return functions[0].getText(serialsSource);
}

describe("the saved order's Serials grid", () => {
  type Row = { key: string; isNew: boolean; serial: string; description: string };
  const gridRows = (...values: string[]): Row[] =>
    values.map((serial, i) => ({ key: `r${i + 1}`, isNew: false, serial, description: "" }));
  /** The grid's own `dupes`, from its own initializer, over these rows. */
  function dupesOf(rows: Row[]): Set<string> {
    const written = declared(SERIALS_FILE, "dupes");
    expect(written).toHaveLength(1);
    return run<Set<string>>(written[0], { findDuplicateSerials, rows });
  }
  /** The grid's `save` as it is written, over these rows: what it refused, and what it sent.
   *  `grid.binding` is a stub with the three methods `save` calls (`capture`, `dispatched`,
   *  `settle`), so a `save` that refuses nothing goes on to `applyMutation` and the PUT, and
   *  "sent nothing" can fail. The stub proves nothing about capture or settle themselves:
   *  order-recovery-lifecycle.test.ts runs this `save` against a real binding. */
  async function save(...values: string[]) {
    const rows = gridRows(...values);
    const onError = vi.fn();
    const api = vi.fn(async () => ({}));
    const applyMutation = vi.fn(async (mutate: () => Promise<unknown>) => { await mutate(); });
    const binding = { capture: () => ({ submitted: { baseline: [] } }), dispatched: () => true, settle: () => {} };
    const saveNow = run<() => Promise<void>>(lifted("save"), {
      dupes: dupesOf(rows), rows, onError, api, applyMutation,
      line: { id: "line-1", position: 1 }, lineLabel: run(lifted("lineLabel"), {}),
      grid: { binding, canEdit: true }, editGate: { allowed: true }, orderId: "order-1",
      projectSerials: () => ({ baseline: [] }), orderAckSnapshot: vi.fn(), ApiError, newId,
    });
    await saveNow();
    return { errors: onError.mock.calls.map(call => call[0]), sent: api.mock.calls.length + applyMutation.mock.calls.length };
  }

  it("sends clean rows: the PUT goes out and nothing is refused", async () => {
    expect(await save("A", "B ")).toEqual({ errors: [null], sent: 2 });
  });

  it("refuses a serial repeated once trimmed, quoting the trimmed value, and sends nothing", async () => {
    expect(await save("A", "A ")).toEqual({ errors: ['Lead: duplicate serial "A".'], sent: 0 });
  });

  it("refuses two blank serials as blank, never as a duplicate, and sends nothing", async () => {
    expect(await save("", "  ")).toEqual({ errors: ["Lead: serial 1 cannot be blank."], sent: 0 });
    expect(await save("", "")).toEqual({ errors: ["Lead: serial 1 cannot be blank."], sent: 0 });
  });

  it("marks both rows of a serial repeated once trimmed", () => {
    const classes = jsxTags(SERIALS_FILE).filter(tag => tag.name === "div" && tag.attr("className")?.includes("dupes.has"));
    expect(classes).toHaveLength(1);
    const className = classes[0].attr("className")!;
    const rows = gridRows("A", "A ", "B");
    const dupes = dupesOf(rows);
    expect(rows.map(row => run<string>(className, { dupes, row }).includes("border-red-400"))).toEqual([true, true, false]);
  });
});
