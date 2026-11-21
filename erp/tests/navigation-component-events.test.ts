import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { shouldGuardNavigation } from "../src/lib/unsaved-guard";

const shellPath = "src/components/Shell.tsx";
function source(path: string) { return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function execute<T>(node: ts.Node, file: ts.SourceFile, environment: Record<string, unknown>): T {
  const code = ts.transpileModule(`return (${node.getText(file)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T;
}
afterEach(() => vi.unstubAllGlobals());
it.each([
  "src/app/orders/[id]/InvoicesSection.tsx", "src/app/shipping/[id]/ShipmentDetail.tsx", shellPath,
])("actual committed lifetime effect at %s retires its captured token permanently", path => {
  const file = source(path); const effects: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect" && node.arguments[0]) {
      const effect = node.arguments[0];
      let assignsLifetime = false;
      const assigned = (child: ts.Node) => {
        if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isPropertyAccessExpression(child.left) && ts.isIdentifier(child.left.expression)
          && child.left.expression.text === "navigationLifetime" && child.left.name.text === "current") assignsLifetime = true;
        ts.forEachChild(child, assigned);
      };
      assigned(effect);
      if (assignsLifetime) effects.push(effect);
    }
    ts.forEachChild(node, visit);
  };
  visit(file); expect(effects).toHaveLength(1);
  const navigationLifetime: { current: { live: boolean } | null } = { current: null };
  const setup = execute<() => () => void>(effects[0], file, { navigationLifetime, id: "s1", orderId: "o1", pathname: "/orders/o1", invalidateDiscardNavigation: vi.fn() });
  const cleanup = setup(); const first = navigationLifetime.current;
  expect(first).toEqual(expect.objectContaining({ live: true })); expect(cleanup).toBeTypeOf("function");
  cleanup(); expect(first!.live).toBe(false);
  const cleanupNext = setup(); expect(navigationLifetime.current).not.toBe(first); expect(navigationLifetime.current!.live).toBe(true);
  expect(first!.live).toBe(false); cleanupNext();
});

function clickFixture({ dirty = true, consent = true } = {}) {
  const file = source(shellPath); let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === "onClickCapture") found = node; ts.forEachChild(node, visit); }; visit(file);
  expect(found).toBeDefined();
  const attach = vi.fn(() => true); const cancel = vi.fn(); const captureDiscardNavigation = vi.fn(() => ({ isCurrent: () => true, attach, cancel }));
  const invalidateDiscardNavigation = vi.fn(); const confirmDiscard = vi.fn(() => consent);
  class TestElement {
    constructor(readonly anchor: unknown) {}
    closest(selector: string) { expect(selector).toBe("a[href]"); return this.anchor; }
  }
  vi.stubGlobal("Element", TestElement);
  vi.stubGlobal("window", { location: { pathname: "/orders/o1", origin: "http://example.test" } });
  const onClick = execute<(event: unknown) => void>(found!, file, {
    currentUnsavedLabels: () => dirty ? ["Draft"] : [], confirmDiscard, shouldGuardNavigation,
    captureDiscardNavigation, invalidateDiscardNavigation, navigationLifetime: { current: { live: true } },
  });
  function click(options: { href?: string; modifier?: boolean; download?: boolean; document?: boolean; newTab?: boolean; sameOrigin?: boolean; prevented?: boolean } = {}) {
    const href = options.href ?? "/orders/other";
    const anchor = { pathname: href.split("#")[0] || "/orders/o1", hash: href.includes("#") ? `#${href.split("#")[1]}` : "", origin: options.sameOrigin === false ? "http://elsewhere.test" : "http://example.test", target: options.newTab ? "_blank" : "", dataset: { navigation: options.document ? "document" : undefined }, getAttribute: () => href, hasAttribute: () => !!options.download };
    const event = { target: new TestElement(anchor), ctrlKey: !!options.modifier, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: !!options.prevented, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    onClick(event); return event;
  }
  return { click, attach, cancel, captureDiscardNavigation, invalidateDiscardNavigation, confirmDiscard };
}
it.each([
  { modifier: true }, { download: true }, { href: "#readings" }, { document: true },
  { href: "/orders/o1" }, { newTab: true }, { sameOrigin: false }, { prevented: true },
])("actual capture listener preserves the navigation exemption %j", options => {
  const h = clickFixture(); const event = h.click(options);
  expect(h.confirmDiscard).not.toHaveBeenCalled(); expect(h.captureDiscardNavigation).not.toHaveBeenCalled();
  expect(h.invalidateDiscardNavigation).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled();
});
it("a clean cross-page link still supersedes a held business callback before navigation", () => {
  const h = clickFixture({ dirty: false }); const event = h.click();
  expect(h.captureDiscardNavigation).toHaveBeenCalledTimes(1);
  expect(h.attach).toHaveBeenCalledExactlyOnceWith("/orders/other"); expect(event.preventDefault).not.toHaveBeenCalled();
});
it("a rejected link confirmation cancels only its new operation and blocks native Link departure", () => {
  const h = clickFixture({ consent: false }); const event = h.click();
  expect(h.captureDiscardNavigation).toHaveBeenCalledTimes(1); expect(h.cancel).toHaveBeenCalledTimes(1);
  expect(h.attach).not.toHaveBeenCalled(); expect(event.preventDefault).toHaveBeenCalledTimes(1); expect(event.stopPropagation).toHaveBeenCalledTimes(1);
});
it("an accepted dirty link attaches once before allowing default navigation", () => {
  const h = clickFixture(); const event = h.click();
  expect(h.captureDiscardNavigation).toHaveBeenCalledTimes(1); expect(h.confirmDiscard).toHaveBeenCalledTimes(1);
  expect(h.attach).toHaveBeenCalledExactlyOnceWith("/orders/other"); expect(event.preventDefault).not.toHaveBeenCalled();
});
