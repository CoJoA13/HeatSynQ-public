// P6 step 4: ruling R1 (owner, 2026-10-22) puts a grid's, row's or section's refusal beside its
// control, through the one shared `PanelMessage` (src/components/PanelMessage.tsx), and keeps the
// page-top banner for page-level actions (Print, Unlock, Discard, Post, Void). A page that hands its
// banner setter to a child section (`onError={setError}`) sends that section's refusals to the top
// of the page, far from the control, which is the placement R1 retired.
//
// This census walks every client `.tsx` under src/, parsed, and fails closed:
//   - a JSX attribute on a component (a capitalised tag) whose value is a `set…Error` setter, or a
//     function that calls one, is refused unless the allowlist names it with a reason;
//   - a `return` of `<div className="p-6">` holding the text "Loading…" is refused (#634: a detail
//     page's pre-load branch is `PageStatus`, src/components/PageStatus.tsx).
// The allowlist started with the sites the 2026-10-22 review counted, each tagged with the P6 step-5
// pull request that removed it, and its size is pinned, so a new handoff is a decision and a removed
// one cannot leave a stale entry behind. One entry stands: the part's Identity section, whose boxes
// are header blur-saves the owner kept on the page banner (2026-10-28).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const BANNER_SETTER = /^set\w*Error$/;

/** `file <Tag> attribute` → why it is still allowed and which P6 step-5 PR removes it. */
const ALLOWED: Record<string, string> = {
  "app/parts/[id]/page.tsx <IdentitySection> onError": "standing: its boxes are the header's blur-saves, which stay on the page banner (owner ruling 2026-10-28, P6 step 5c), as the hub's Overview and Notes, the invoice header and the customer header do",
};
// A pin, not a ceiling: it moved down with each step-5 PR and stands at 1, the part's Identity
// section, since the owner's ruling of 2026-10-28 kept the header blur-saves on the banner.
const ALLOWED_COUNT = 1;

function clientFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "api" ? [] : clientFiles(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

/** Whether `node` is a banner setter, or a function that forwards one of its own parameters into
 *  one (`(m) => setError(m)`): the setter handed on by another spelling. A callback that only
 *  clears a section's own message (`() => setRangeError(null)`) hands nothing on. */
function handsBannerSetter(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return BANNER_SETTER.test(node.text);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const params = new Set(node.parameters.map((p) => p.name.getText()));
    let hit = false;
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && BANNER_SETTER.test(n.expression.text)
        && n.arguments.some((arg) => {
          let uses = false;
          const look = (x: ts.Node) => { if (ts.isIdentifier(x) && params.has(x.text)) uses = true; ts.forEachChild(x, look); };
          look(arg);
          return uses;
        })) hit = true;
      ts.forEachChild(n, walk);
    };
    walk(node.body);
    return hit;
  }
  return false;
}

/** Whether `node` holds the string "Loading…" as a literal, without looking inside nested JSX: the
 *  retired form is the text itself as the div's child (`{error ?? "Loading…"}`), not a page body
 *  with a loading line somewhere inside it. */
function holdsLoading(node: ts.Node): boolean {
  if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === "Loading…") return true;
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return false;
  return ts.forEachChild(node, (child) => holdsLoading(child) || undefined) ?? false;
}
const directLoading = (child: ts.JsxChild): boolean =>
  (ts.isJsxText(child) && child.text.trim() === "Loading…") || (ts.isJsxExpression(child) && !!child.expression && holdsLoading(child.expression));

/** The bare `<div className="p-6">` pre-load form #634 retired. */
function isBarePreLoad(node: ts.Expression): boolean {
  const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
  if (!ts.isJsxElement(inner)) return false;
  const open = inner.openingElement;
  if (open.tagName.getText() !== "div") return false;
  const cls = open.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === "className");
  const value = cls && ts.isJsxAttribute(cls) && cls.initializer && ts.isStringLiteral(cls.initializer) ? cls.initializer.text : "";
  return value === "p-6" && inner.children.some(directLoading);
}

const found = (() => {
  const handoffs = new Map<string, number>();
  const preLoads: string[] = [];
  for (const full of clientFiles(ROOT)) {
    const rel = full.slice(ROOT.length + 1);
    const file = ts.createSourceFile(full, readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const walk = (n: ts.Node) => {
      if (ts.isJsxAttribute(n) && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression) {
        const element = n.parent.parent;
        const tag = (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) ? element.tagName.getText(file) : "";
        if (/^[A-Z]/.test(tag) && handsBannerSetter(n.initializer.expression)) {
          const key = `${rel} <${tag}> ${n.name.getText(file)}`;
          handoffs.set(key, (handoffs.get(key) ?? 0) + 1);

        }
      }
      if (ts.isReturnStatement(n) && n.expression && isBarePreLoad(n.expression)) {
        preLoads.push(`${rel}:${file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1}`);
      }
      ts.forEachChild(n, walk);
    };
    walk(file);
  }
  return { handoffs, preLoads };
})();

describe("message slots (P6 step 4, ruling R1)", () => {
  it("no section is handed the page banner's setter except the allowlisted step-5 sites", () => {
    const unlisted = [...found.handoffs.keys()].filter((key) => !(key in ALLOWED));
    expect(unlisted).toEqual([]);
  });

  it("every allowlist entry is still a live handoff, once, and the count is pinned", () => {
    const stale = Object.keys(ALLOWED).filter((key) => found.handoffs.get(key) !== 1).map((key) => `${key} = ${found.handoffs.get(key)}`);
    expect(stale).toEqual([]);
    expect(Object.keys(ALLOWED)).toHaveLength(ALLOWED_COUNT);
    expect([...found.handoffs.values()].reduce((a, b) => a + b, 0)).toBe(ALLOWED_COUNT);
  });

  it("no client file returns the bare p-6 Loading… div (#634: PageStatus)", () => {
    expect(found.preLoads).toEqual([]);
  });
});
