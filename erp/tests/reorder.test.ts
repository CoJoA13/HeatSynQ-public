import { describe, expect, it } from "vitest";
import { gate } from "@/lib/permission-ui";
import { moveGate, swapAt } from "@/lib/reorder";

// The bounds-check-and-swap every up/down control in the app repeats before sending a reorder.
// Extracted here for the same reason next-sort.ts was: it is the part with edge cases, and the
// components around it are unreachable from vitest's "node" environment.

describe("swapAt", () => {
  it("swaps with the previous entry", () => {
    expect(swapAt(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
  });

  it("swaps with the next entry", () => {
    expect(swapAt(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });

  it("refuses to move the first entry up", () => {
    expect(swapAt(["a", "b"], 0, -1)).toBeNull();
  });

  it("refuses to move the last entry down", () => {
    expect(swapAt(["a", "b"], 1, 1)).toBeNull();
  });

  it("refuses an index outside the array", () => {
    expect(swapAt(["a", "b"], 5, -1)).toBeNull();
    expect(swapAt(["a", "b"], -1, 1)).toBeNull();
  });

  it("refuses to move the only entry either way", () => {
    expect(swapAt(["a"], 0, -1)).toBeNull();
    expect(swapAt(["a"], 0, 1)).toBeNull();
  });

  it("never mutates the array it was given", () => {
    const items = ["a", "b", "c"];
    swapAt(items, 0, 1);
    expect(items).toEqual(["a", "b", "c"]);
  });
});

// §5.16 (#363, #395): one answer for an ↑/↓ button's `disabled` and `title`, so the six lists
// that use it cannot word an end of the list differently or forget to say it.
describe("moveGate", () => {
  const open = { disabled: false, title: undefined };
  // A real gate, with its `allowed` key: only `disabled` and `title` may reach the button.
  const refused = gate([], "parts.edit");

  it("disables ↑ on the first row and ↓ on the last, and says which end it is", () => {
    expect(moveGate(open, 0, 3, -1)).toEqual({ disabled: true, title: "Already first" });
    expect(moveGate(open, 2, 3, 1)).toEqual({ disabled: true, title: "Already last" });
  });

  it("treats a lone row as both ends", () => {
    expect(moveGate(open, 0, 1, -1)).toEqual({ disabled: true, title: "Already first" });
    expect(moveGate(open, 0, 1, 1)).toEqual({ disabled: true, title: "Already last" });
  });

  it("leaves a possible move enabled, with no title", () => {
    for (const [index, direction] of [[0, 1], [1, -1], [1, 1], [2, -1]] as const) {
      expect(moveGate(open, index, 3, direction)).toEqual({ disabled: false, title: undefined });
    }
    // An enabled gate's own title is not the button's: only a reason for being disabled is shown.
    expect(moveGate({ disabled: false, title: "not shown" }, 1, 3, -1)).toEqual({ disabled: false, title: undefined });
  });

  it("names the end, not an enabled gate's title, on an end row", () => {
    const titled = { disabled: false, title: "not shown" };
    expect(moveGate(titled, 0, 3, -1)).toEqual({ disabled: true, title: "Already first" });
    expect(moveGate(titled, 2, 3, 1)).toEqual({ disabled: true, title: "Already last" });
  });

  it("finds the last row of a longer list", () => {
    expect(moveGate(open, 4, 5, 1)).toEqual({ disabled: true, title: "Already last" });
    expect(moveGate(open, 2, 5, 1)).toEqual({ disabled: false, title: undefined });
  });

  it("puts the gate's reason first, on every row, the ends included", () => {
    for (let index = 0; index < 3; index++) {
      expect(moveGate(refused, index, 3, -1)).toEqual({ disabled: true, title: "Requires parts.edit" });
      expect(moveGate(refused, index, 3, 1)).toEqual({ disabled: true, title: "Requires parts.edit" });
    }
  });

  it("keeps a gate that is disabled without a reason silent, rather than naming an end", () => {
    expect(moveGate({ disabled: true, title: undefined }, 0, 3, -1)).toEqual({ disabled: true, title: undefined });
  });

  it("answers for a list nothing gates", () => {
    expect(moveGate(null, 0, 2, -1)).toEqual({ disabled: true, title: "Already first" });
    expect(moveGate(null, 1, 2, 1)).toEqual({ disabled: true, title: "Already last" });
    expect(moveGate(null, 1, 2, -1)).toEqual({ disabled: false, title: undefined });
  });
});
