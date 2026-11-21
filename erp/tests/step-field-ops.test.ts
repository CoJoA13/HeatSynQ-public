import { describe, expect, it } from "vitest";
import { fieldLabelDraftKey, moveFieldById, relabelFieldById, removeFieldById } from "@/lib/step-field-ops";

// #650: the step-codes page queues each suggestion edit as a transform over the field set as it
// stands when the op RUNS (after the previous op's save and reload), so the array is fresh. The
// callers used to pass the render index captured at click, so two quick removes of adjacent rows
// removed the clicked row and then its successor by the old index. Each transform now finds its
// row by id. Mutation: look the row up by an index and the first case reds.
type F = { id?: string; label: string; sort: number };
const fields = (): F[] => ["A", "B", "C", "D", "E"].map((label, sort) => ({ id: label.toLowerCase(), label, sort }));

describe("removeFieldById", () => {
  it("two removes of adjacent rows, the second applied to the first's result, omit the rows clicked, not a successor", () => {
    const afterFirst = removeFieldById(fields(), "c");
    expect(afterFirst?.map((f) => f.id)).toEqual(["a", "b", "d", "e"]);
    const afterSecond = removeFieldById(afterFirst!, "d");
    expect(afterSecond?.map((f) => f.id)).toEqual(["a", "b", "e"]);
  });

  it("an id no longer present is the queue's no-op", () => {
    expect(removeFieldById(fields(), "zz")).toBeNull();
  });

  it("never mutates the array it was given", () => {
    const cur = fields();
    removeFieldById(cur, "a");
    expect(cur.map((f) => f.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("moveFieldById", () => {
  it("moves the row by its id's current position: a move queued behind a remove still moves the row clicked", () => {
    const afterRemove = removeFieldById(fields(), "a")!;
    expect(moveFieldById(afterRemove, "c", -1)?.map((f) => f.id)).toEqual(["c", "b", "d", "e"]);
  });

  it("a row at its end of the list, or an unknown id, is a no-op", () => {
    expect(moveFieldById(fields(), "a", -1)).toBeNull();
    expect(moveFieldById(fields(), "e", 1)).toBeNull();
    expect(moveFieldById(fields(), "zz", 1)).toBeNull();
  });
});

describe("relabelFieldById", () => {
  it("relabels the row clicked after a move changed every index", () => {
    const moved = moveFieldById(fields(), "a", 1)!;
    expect(moved.map((f) => f.id)).toEqual(["b", "a", "c", "d", "e"]);
    const relabelled = relabelFieldById(moved, "b", "Bee");
    expect(relabelled?.map((f) => [f.id, f.label])).toEqual([["b", "Bee"], ["a", "A"], ["c", "C"], ["d", "D"], ["e", "E"]]);
  });

  it("an id no longer present is the queue's no-op", () => {
    expect(relabelFieldById(fields(), "zz", "x")).toBeNull();
  });
});

describe("fieldLabelDraftKey", () => {
  it("keys a label draft by the code and the suggestion's id, the key space the rendered rows use (#288)", () => {
    expect(fieldLabelDraftKey("code-1", "field-9")).toBe("code-1.field-9.label");
  });
});
