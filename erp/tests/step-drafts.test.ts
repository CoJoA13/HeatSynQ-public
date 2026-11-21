import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { stagePendingRekey } from "@/lib/step-drafts";

// The staged re-key behind ProcessStepsSection's draft adapter, extracted so it can be tested at
// all: the vitest environment is "node" with no DOM, so the component itself is out of reach — the
// next-sort.ts / permission-ui.ts precedent.

// #288: a recipe-number save's response carries the cut's mapping a full round trip before the rows
// it renumbers, which arrive only with the follow-up read (`refreshAfter`). Re-keying on arrival
// left the draft and the rendered rows disagreeing about every step's name
// for that whole window — drafts vanished from their inputs, a keystroke landed under a pre-cut id
// nothing could reach again, and the section read dirty on a page nobody had touched. The mapping
// is staged instead, and applied in the same commit that installs the new rows.
describe("stagePendingRekey", () => {
  it("stages nothing when no cut happened", () => {
    // The everyday amend-in-place path. Mutation-proof: drop the empty-map guard and a no-cut
    // save stages a mapping that would later re-key the draft to nothing.
    expect(stagePendingRekey(null, 3, {})).toBeNull();
    const held = { toRevision: 2, map: { a: "a2" } };
    expect(stagePendingRekey(held, 2, {})).toBe(held);
  });

  it("records the mapping against the revision it produced", () => {
    expect(stagePendingRekey(null, 2, { a: "a2" })).toEqual({ toRevision: 2, map: { a: "a2" } });
  });

  it("COMPOSES across two cuts, so a draft two cuts behind still resolves", () => {
    // Mutation-proof: replace the composition with a plain merge and `a` still points at `a2`,
    // a revision that no longer exists — the draft would be re-keyed onto nothing.
    const first = stagePendingRekey(null, 2, { a: "a2" });
    const second = stagePendingRekey(first, 3, { a2: "a3" });
    expect(second).toEqual({ toRevision: 3, map: { a: "a3", a2: "a3" } });
  });
});

// The binding owns the ordered draft and the staged cut. Keep the source wiring half alongside
// the pure helper tests; task-8-callbacks and process-steps-selection-recovery additionally
// execute every actual callback with throwing history UI and assert its settlement behavior.
describe("ProcessStepsSection step-draft call sites", () => {
  const source = (path: string) => ts.createSourceFile(path, readFileSync(join(process.cwd(), path), "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const component = source("src/app/parts/[id]/ProcessStepsSection.tsx");
  const leaf = source("src/lib/process-steps-recovery.ts");
  const text = (node: ts.Node) => node.getText().replace(/\s+/g, "");
  function nodes<T extends ts.Node>(root: ts.Node, predicate: (n: ts.Node) => n is T): T[] {
    const result: T[] = []; const walk = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, walk); }; walk(root); return result;
  }
  const fn = (root: ts.Node, name: string) => {
    const found = nodes(root, ts.isFunctionDeclaration).find(n => n.name?.text === name);
    expect(found, `actual ${name} function`).toBeDefined(); return found!;
  };
  const calls = (root: ts.Node, name: string) => nodes(root, ts.isCallExpression).filter(n => text(n.expression) === name);
  const property = (root: ts.Node, name: string) => {
    const found = nodes(root, ts.isPropertyAssignment).find(n => text(n.name) === name);
    expect(found, `actual ${name} property`).toBeDefined(); return found!.initializer;
  };

  it("local row changes replace the selected ordered draft", () => {
    const change = fn(component, "changeRows");
    expect(calls(change, "binding?.change")).toHaveLength(1);
    const ordered = calls(change, "newMap(d.orderedEdits).set");
    expect(ordered).toHaveLength(1);
    expect(ordered[0].arguments.map(text)).toEqual(["selected??0", "next"]);
  });

  it("the one atomic document mutator settles its captured mapping before history or refresh", () => {
    const action = fn(component, "saveProcessAction"); const prepare = calls(action, "prepareProcessSteps")[0];
    expect(text(property(prepare.arguments[1], "kind"))).toBe('"document"');
    const api = calls(action, "api").find(call => text(call.arguments[0]).includes("/process/document"));
    expect(api).toBeDefined(); expect(ts.isAwaitExpression(api!.parent)).toBe(true);
    const persisted = calls(action, "binding.settle").filter(c => text(property(c.arguments[1], "kind")) === '"persisted"');
    expect(persisted).toHaveLength(1);
    expect(text(persisted[0].arguments[0])).toBe("captured.submission");
    const response = nodes(persisted[0].arguments[1], ts.isShorthandPropertyAssignment).find(node => text(node.name) === "response");
    expect(response).toBeDefined();
    const history = calls(action, "invalidateHistory"), refresh = calls(action, "refreshAfter");
    expect(history).toHaveLength(1); expect(refresh).toHaveLength(1);
    expect(api!.getStart()).toBeLessThan(persisted[0].getStart());
    expect(persisted[0].getStart()).toBeLessThan(history[0].getStart());
    expect(persisted[0].getStart()).toBeLessThan(refresh[0].getStart());
  });

  it("qualified read and Restore share a landing that returns the draft, selected revision, stage and baseline together", () => {
    for (const name of ["reconcileRead", "reconcileRestore"]) {
      const landing = calls(property(leaf, name), "processStepsLand");
      expect(landing, name).toHaveLength(1); expect(landing[0].arguments.map(text), name).toEqual(["current", "fresh"]);
    }
    // The staged mapping is applied to the ordered rows at the landing, never on arrival (#288).
    const land = fn(leaf, "processStepsLand"); expect(calls(land, "mapOrdered")).toHaveLength(1);
    const finalReturn = land.body!.statements[land.body!.statements.length - 1]; expect(ts.isReturnStatement(finalReturn)).toBe(true);
    const returned = (finalReturn as ts.ReturnStatement).expression!;
    expect(text(property(returned, "baseline"))).toBe("fresh");
    const data = property(returned, "data");
    expect(text(property(data, "pendingRekey"))).toBe("null");
    expect(nodes(data, ts.isShorthandPropertyAssignment).map(n => n.name.text)).toContain("orderedEdits");
    expect(text(property(data, "selectedRevision"))).toContain("fresh.selectedRevision");
    const load = nodes(component, ts.isVariableDeclaration).find(n => text(n.name) === "load")!;
    expect(calls(load, "readProcessSteps")).toHaveLength(1);
    for (const setter of ["setEdits", "setDetail", "setSelected"]) expect(calls(component, setter), setter).toHaveLength(0);
    const detail = nodes(component, ts.isVariableDeclaration).find(n => text(n.name) === "detail")!;
    expect(text(detail.initializer!)).toBe("selected===null?undefined:baseline?.revisions.get(selected)");
  });
});
