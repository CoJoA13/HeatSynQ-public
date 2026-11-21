import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { subscribeHistoryInvalidations, invalidateHistory } from "@/components/HistoryPanel";
import { callsBareIdentifier } from "./helpers/ts-parse";

// #14 item 1 — the module-level listener-Set invalidation idiom (the SetupBanner/BackupBanner
// shape), pinned the way tests/setup-banner.test.tsx pins its subscribe/invalidate contract:
// this repo has no DOM test environment, so the exported contract is the tested path and the
// component's own effect subscribes through the same export.
describe("history invalidation (#14 item 1)", () => {
  it("notifies every subscriber per invalidation, until unsubscribed", () => {
    let a = 0;
    let b = 0;
    const unsubA = subscribeHistoryInvalidations(() => { a += 1; });
    const unsubB = subscribeHistoryInvalidations(() => { b += 1; });

    invalidateHistory();
    expect(a).toBe(1);
    expect(b).toBe(1);

    unsubA();
    invalidateHistory();
    expect(a).toBe(1);
    expect(b).toBe(2);

    unsubB();
    invalidateHistory();
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("an invalidation with no subscribers is a no-op, and a double-unsubscribe is harmless", () => {
    const unsub = subscribeHistoryInvalidations(() => {});
    unsub();
    unsub();
    expect(() => invalidateHistory()).not.toThrow();
  });
});

// #620: the panel asks the leaf before it sends anything. The leaf's answers are pinned in
// tests/history-access.test.ts; this pins the WIRING, parsed: the component calls `historyAccess`,
// and its one `api(` call is reached only under the allowed branch (the call sits inside an `if`
// whose condition names `allowed`, or after an early return that does). The required `perms` and
// `permsError` props make a mount that passes nothing a compile error, so the mounts need no sweep.
describe("HistoryPanel sends its read only when historyAccess allows it (#620)", () => {
  const file = join(process.cwd(), "src/components/HistoryPanel.tsx");
  const src = readFileSync(file, "utf8");

  it("calls historyAccess, by its bare name", () => {
    expect(callsBareIdentifier(src, "historyAccess", "HistoryPanel.tsx")).toBe(true);
  });

  it("guards its api() call on the allowed answer", () => {
    const source = ts.createSourceFile("HistoryPanel.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const apiCalls: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "api") apiCalls.push(n);
      ts.forEachChild(n, visit);
    };
    visit(source);
    expect(apiCalls).toHaveLength(1);
    // Walk up from the call to the enclosing arrow function (the effect body) and require, in
    // that body, before the call's statement, a statement that returns unless access is allowed.
    let fn: ts.Node | undefined = apiCalls[0];
    while (fn && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) fn = fn.parent;
    expect(fn).toBeDefined();
    const body = (fn as ts.ArrowFunction).body;
    expect(ts.isBlock(body)).toBe(true);
    const statements = (body as ts.Block).statements;
    const callIndex = statements.findIndex((st) => st.getStart() <= apiCalls[0].getStart() && apiCalls[0].getEnd() <= st.getEnd());
    const guards = statements.slice(0, callIndex).filter((st) =>
      ts.isIfStatement(st) && /allowed/.test(st.expression.getText()) && /return/.test(st.thenStatement.getText()));
    expect(guards.length).toBeGreaterThan(0);
  });
});
