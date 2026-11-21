// R7 (P8 step 3): one green Saved mark for every blur-save box, shown while the box shows the
// value its newest landed save carried.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SavedMark } from "@/components/SavedMark";
import { recordSaved, savedShows } from "@/lib/saved-mark";

describe("savedShows", () => {
  it("shows nothing for a box with no landed save", () => {
    expect(savedShows({}, "po", "A1")).toBe(false);
    expect(savedShows({}, "constructor", "")).toBe(false);
  });
  it("shows while a text box shows the saved text, trimmed, and goes when it changes", () => {
    const last = recordSaved({}, "po", "A1 ");
    expect(savedShows(last, "po", "A1")).toBe(true);
    expect(savedShows(last, "po", "A2")).toBe(false);
    expect(savedShows(last, "other", "A1")).toBe(false);
  });
  it("reads a decimal box as a figure, so its own re-spelling keeps the mark", () => {
    const last = recordSaved({}, "price", "0.55", true);
    expect(savedShows(last, "price", "0.5500")).toBe(true);
    expect(savedShows(last, "price", ".55")).toBe(true);
    expect(savedShows(last, "price", "0.56")).toBe(false);
    expect(savedShows(recordSaved({}, "po", "0.55"), "po", "0.5500")).toBe(false);
  });
  it("keeps the newest save of a box", () => {
    const last = recordSaved(recordSaved({}, "po", "A1"), "po", "B2");
    expect(savedShows(last, "po", "A1")).toBe(false);
    expect(savedShows(last, "po", "B2")).toBe(true);
  });
});

describe("SavedMark", () => {
  it("draws the order hub Lines boxes' Saved span, and nothing when not shown", () => {
    expect(renderToStaticMarkup(<SavedMark label="PO number" show />))
      .toBe('<span role="status" aria-label="PO number saved" class="ml-2 text-xs text-success-700">Saved</span>');
    expect(renderToStaticMarkup(<SavedMark label="PO number" show={false} />)).toBe("");
  });
});

describe("no page draws its own saved flash (R7)", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
  const hits: string[] = [];
  for (const file of walk(SRC).filter((f) => f.endsWith(".tsx"))) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const where = (n: ts.Node) => `${relative(SRC, file).split(sep).join("/")}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const visit = (node: ts.Node): void => {
      // An italic "saved" (the old Accounting and Settings flash).
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === "em"
          && /\bsaved\b/i.test(node.children.map((c) => c.getText(sf)).join(""))) hits.push(`${where(node)} em`);
      // A timer that clears a saved state.
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "setTimeout") {
        let clears = false;
        const look = (n: ts.Node): void => { if (ts.isIdentifier(n) && /^set\w*Saved/i.test(n.text)) clears = true; ts.forEachChild(n, look); };
        look(node);
        if (clears) hits.push(`${where(node)} setTimeout`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  it("finds none", () => {
    expect(hits).toEqual([]);
  });
});
