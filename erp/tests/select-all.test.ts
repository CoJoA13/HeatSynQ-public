import { describe, expect, it } from "vitest";
import { applySelectAll, selectAllState } from "@/lib/select-all";

/**
 * #239 C9a — the header select-all over the invoicing list's ready-to-invoice rows, proved at the
 * leaf because that is the only place it CAN be proved: vitest here runs `environment: "node"` with
 * no component renderer, and `InvoicingList` fills its candidate rows from a landed fetch that SSR
 * never resolves, so a rule written inline in that table is unreachable by any test in this gate
 * set (the `step-drafts.ts` / `break-drafts.ts` reasoning, CLAUDE.md).
 *
 * The cases are in two groups because the leaf has two halves, and the same property — a key the
 * header does not govern is neither reported on nor written to — has to hold in both. It can fail
 * independently in each: a state that counted `selected.size` would read "some" on a page nobody
 * had ticked, and a write that replaced the set would clear a tick that was never on screen.
 */

describe("selectAllState — what the header box shows (C9a)", () => {
  const selectable = ["order-1", "order-2", "order-3"];

  it("is 'all' when every selectable row is ticked", () => {
    expect(selectAllState(selectable, new Set(selectable))).toBe("all");
  });

  it("is 'none' when no selectable row is ticked", () => {
    expect(selectAllState(selectable, new Set())).toBe("none");
  });

  it("is 'some' — the indeterminate dash — when only part of them are", () => {
    expect(selectAllState(selectable, new Set(["order-2"]))).toBe("some");
    expect(selectAllState(selectable, new Set(["order-1", "order-3"]))).toBe("some");
  });

  it("is 'none' with nothing selectable, never the vacuous 'all'", () => {
    // `[].every(...)` is true, so the natural spelling claims a full selection above a table with
    // nothing in it. The caller disables the box in this state; this is what it shows while disabled.
    expect(selectAllState([], new Set())).toBe("none");
    expect(selectAllState([], new Set(["order-9"]))).toBe("none");
  });

  it("ignores ticks for rows it does not govern, in both directions", () => {
    // A selection may hold keys that are not selectable here — a row whose own checkbox is
    // disabled, or a tick the caller kept across a reload it could not reconcile. Counting the
    // SELECTION rather than the intersection makes an untouched page read "some".
    expect(selectAllState(selectable, new Set(["elsewhere"]))).toBe("none");
    expect(selectAllState(selectable, new Set([...selectable, "elsewhere"]))).toBe("all");
  });
});

describe("applySelectAll — what the header box writes (C9a)", () => {
  const selectable = ["order-1", "order-2", "order-3"];

  it("ticks every selectable row when checked", () => {
    expect([...applySelectAll(new Set(["order-2"]), selectable, true)].sort())
      .toEqual(["order-1", "order-2", "order-3"]);
  });

  it("clears every selectable row when unchecked", () => {
    expect([...applySelectAll(new Set(selectable), selectable, false)]).toEqual([]);
  });

  it("leaves keys outside the selectable set alone, ticking AND clearing", () => {
    // The other half of the rule above: select-all must not tick a row the operator cannot tick,
    // and select-none must not silently clear something the header never showed.
    expect([...applySelectAll(new Set(["elsewhere"]), selectable, true)].sort())
      .toEqual(["elsewhere", "order-1", "order-2", "order-3"]);
    expect([...applySelectAll(new Set([...selectable, "elsewhere"]), selectable, false)])
      .toEqual(["elsewhere"]);
  });

  it("returns a new set and never mutates the one it was given", () => {
    // It is called from a React setState updater, where mutating the previous value is a bug
    // independent of anything here (bulk-grid.ts's `patchAdded`/`appendRows` rule).
    const before = new Set(["order-1"]);
    const after = applySelectAll(before, selectable, true);
    expect(after).not.toBe(before);
    expect([...before]).toEqual(["order-1"]);
  });

  it("is a no-op on the selection when nothing is selectable", () => {
    expect([...applySelectAll(new Set(["elsewhere"]), [], true)]).toEqual(["elsewhere"]);
    expect([...applySelectAll(new Set(["elsewhere"]), [], false)]).toEqual(["elsewhere"]);
  });
});
