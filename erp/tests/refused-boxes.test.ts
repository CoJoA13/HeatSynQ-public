import { describe, expect, it } from "vitest";
import { markRefused, refusedBox, type BoxDocument, type BoxNode } from "@/lib/refused-boxes";

/** A tag and its attributes, with at most one child: enough for an id on a box or on its wrapper. */
function node(tag: string, attrs: Record<string, string> = {}, child: BoxNode | null = null): BoxNode & { attrs: Record<string, string> } {
  const self = {
    attrs: { ...attrs },
    matches: (selector: string) => selector.split(",").includes(tag),
    querySelector: (selector: string): BoxNode | null => (child && (child.matches(selector) ? child : child.querySelector(selector))),
    hasAttribute: (name: string) => name in self.attrs,
    setAttribute: (name: string, value: string) => { self.attrs[name] = value; },
    removeAttribute: (name: string) => { delete self.attrs[name]; },
  };
  return self;
}
const doc = (byId: Record<string, BoxNode>): BoxDocument => ({ getElementById: (id) => byId[id] ?? null });

describe("refusedBox", () => {
  it("takes the element an id names when it is a control, else the first control inside it", () => {
    const input = node("input");
    const wrapped = node("input");
    const d = doc({ box: input, wrapper: node("div", {}, node("span", {}, wrapped)), empty: node("div") });
    expect(refusedBox(d, "box")).toBe(input);
    expect(refusedBox(d, "wrapper")).toBe(wrapped);
    expect(refusedBox(d, "empty")).toBeNull();
    expect(refusedBox(d, "missing")).toBeNull();
  });
});

describe("markRefused", () => {
  it("marks every named box once and the cleanup takes each mark off", () => {
    const a = node("input"); const b = node("select"); const c = node("textarea");
    const undo = markRefused(doc({ a, b, wrap: node("div", {}, c) }), ["a", "b", "wrap", "a", "missing"]);
    expect([a.attrs, b.attrs, c.attrs]).toEqual([{ "aria-invalid": "true" }, { "aria-invalid": "true" }, { "aria-invalid": "true" }]);
    undo();
    expect([a.attrs, b.attrs, c.attrs]).toEqual([{}, {}, {}]);
  });

  it("marks no button, and leaves a box's own mark as the page set it", () => {
    const save = node("button");
    const own = node("input", { "aria-invalid": "false" });
    const undo = markRefused(doc({ save, own }), ["save", "own"]);
    expect(save.attrs).toEqual({});
    expect(own.attrs).toEqual({ "aria-invalid": "false" });
    undo();
    expect(own.attrs).toEqual({ "aria-invalid": "false" });
  });
});
