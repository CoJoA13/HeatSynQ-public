import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { methodOf, namesAMethod, resolveLocalModule } from "./helpers/ts-parse";

// THE PENDING-ACTION CENSUS (#720, plan P11 step 5).
//
// The rule: a click that sends a write must not be able to send it twice. `api()` and
// `trackedFetch` dedupe nothing, so a second click on a one-shot write button reaches the server,
// where it commits a duplicate or answers a red refusal after the first click's success. A
// control satisfies the rule in one of four ways:
//
//   HELD   a state its `disabled=` reads is set before the request goes out: by the button's
//          `oneShotHold` (src/lib/single-flight.ts), whose `run` the request sits inside, or by
//          a setter the handler calls, directly or through one local helper, ahead of it;
//   ASKED  the request waits on a modal ask (askConfirm, askReason, askDiscard, askPassword);
//   KEYED  the request carries a `clientRequestId` that a second click sends again, so the
//          server answers the retry as the same write;
//   SAVE   the control is `SaveButton`, whose own pending state holds it.
//
// THE SUBJECT IS THE REQUEST. Every call in a client file (under src/app outside src/app/api, and
// under src/components) that sends a non-GET method, or one this cannot read, is walked up through
// the local functions that reach it to the place it is triggered, and each (request, trigger) pair
// takes one verdict. Nothing may be absent:
//
//   - a click (onClick, onSubmit or onDoubleClick on an element, onClick on DangerButton, an
//     ActionMenu item's onSelect) must be HELD, ASKED or KEYED;
//   - SaveButton's onSave and onDiscard are SAVE;
//   - a change, blur or key event (onChange, onBlur, onKeyDown and their kin) is out of scope: the
//     plan's blur-saves and whole-value writes, Enter being the blur's own commit (ruling R7);
//   - a handler handed to another component is followed ONE hop into that component's file, where
//     its own trigger is judged the same way, and a `disabled=` that reads a prop is judged by the
//     parent's attribute for that prop against the parent's half of the path;
//   - a request an effect sends, one sent from a component's render, one no local code reaches,
//     and anything else is unclassified, and an unclassified pair needs an exemption with a reason.
//
// The exemptions are a pinned count. A QUEUED click op (a click that enqueues a run on a page's
// save queue, which composes each run from the state before it) is one kind: a second click is a
// second run, deliberately, so it takes no hold.
//
// WHAT THIS DOES NOT SEE, stated rather than implied away: a request in a file outside the client
// tree; a handler reached through an import rather than a prop; a hold whose state is set but whose
// release is wrong (the leaf's own tests hold `oneShotHold`); and a click that lands while a modal
// ask is open on a slow request, which the ask does not stop. Fails CLOSED: a trigger it cannot
// place, a `disabled=` it cannot read and a prop it cannot follow all report unguarded.
//
// Doctrine cloned from the other parsed sweeps (tests/archival-gate-sweep.test.ts above all):
// parse rather than pattern-match, over-match so a detector fails closed, assert a non-vacuous
// floor, and run each rule against sources written to break it.

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (rel === "src/app/api") continue;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(rel.split(sep).join("/"));
  }
}
const clientFiles = (): string[] => {
  const out: string[] = [];
  walk("src/app", out);
  walk("src/components", out);
  return out.sort();
};

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string, src?: string): ts.SourceFile {
  if (src === undefined) {
    const hit = parsed.get(file);
    if (hit) return hit;
  }
  const text = src ?? read(file);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (src === undefined) parsed.set(file, sf);
  return sf;
}

const lineOf = (sf: ts.SourceFile, n: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

const FN_LIKE = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
  || ts.isMethodDeclaration(n);

/** Through parentheses, `as`, `!` and `satisfies`, to the node that holds the expression. */
function outer(n: ts.Node): ts.Node {
  let p = n.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)
    || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p))) p = p.parent;
  return p;
}

/** The name a function-like node is reachable by: its own, the const it is assigned to, or the
 *  const a `useCallback`/`useMemo` around it is assigned to. */
function fnName(n: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name)) return n.name.text;
  const p = outer(n);
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isCallExpression(p) && ts.isIdentifier(p.expression)
    && (p.expression.text === "useCallback" || p.expression.text === "useMemo")) {
    const q = outer(p);
    if (q && ts.isVariableDeclaration(q) && ts.isIdentifier(q.name)) return q.name.text;
  }
  return undefined;
}

/** The node whose subtree a declaration of this function is visible in. */
function scopeOf(fn: ts.Node): ts.Node {
  let p: ts.Node | undefined = ts.isFunctionDeclaration(fn) ? fn.parent : outer(fn);
  while (p && !ts.isBlock(p) && !ts.isSourceFile(p) && !ts.isModuleBlock(p)) p = p.parent;
  return p ?? fn.getSourceFile();
}

const within = (n: ts.Node, outerNode: ts.Node): boolean =>
  n.getStart() >= outerNode.getStart() && n.getEnd() <= outerNode.getEnd();

function descendants(n: ts.Node, test: (d: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (d: ts.Node): void => { if (test(d)) out.push(d); ts.forEachChild(d, visit); };
  ts.forEachChild(n, visit);
  return out;
}

// ---------------------------------------------------------------------------------------------
// REQUESTS
// ---------------------------------------------------------------------------------------------

const MUTATING = ["POST", "PUT", "PATCH", "DELETE", "UNKNOWN"];

/** Every call in this file that sends a write: one whose callee is `api`, `trackedFetch` or
 *  `fetch`, or whose init names a method (a local wrapper such as the customer page's `call`), with a
 *  method that is not a read. An unreadable method counts as a write (`methodOf`'s UNKNOWN, the
 *  fail-closed direction), so a wrapper's own inner request is a site as well as each call of it.
 *  Unlike the archival sweep, a URL alone does not make a request: a hook that takes an `/api/` path
 *  to read (`useStoredDocuments`) is not one. */
export function writeCalls(sf: ts.SourceFile): ts.CallExpression[] {
  return descendants(sf, (n) => {
    if (!ts.isCallExpression(n)) return false;
    const callee = ts.isIdentifier(n.expression) ? n.expression.text : null;
    const isRequest = callee === "api" || callee === "trackedFetch" || callee === "fetch" || namesAMethod(n.arguments[1]);
    return isRequest && MUTATING.includes(methodOf(n.arguments[1]));
  }) as ts.CallExpression[];
}

// ---------------------------------------------------------------------------------------------
// FROM A REQUEST UP TO WHAT TRIGGERS IT
// ---------------------------------------------------------------------------------------------

/** One function on a path, and the node inside it the path continues from (the request itself in
 *  the first step; a call of, or a reference to, the step before in each later one). */
type Step = { fn: ts.Node; at: ts.Node };

type Trigger =
  | { kind: "attr"; attr: ts.JsxAttribute; element: ts.JsxOpeningLikeElement }
  | { kind: "item"; item: ts.ObjectLiteralExpression }
  | { kind: "effect" | "render" | "unreferenced" | "other"; at: ts.Node; what: string };

type Path = { file: string; sf: ts.SourceFile; steps: Step[]; trigger: Trigger };

const HOOK_DEPS = new Set(["useEffect", "useLayoutEffect", "useCallback", "useMemo"]);

function attrTrigger(attr: ts.JsxAttribute): Trigger {
  return { kind: "attr", attr, element: attr.parent.parent as ts.JsxOpeningLikeElement };
}

/** Where a function placed in an object literal leads: an ActionMenu item's `onSelect`, or the call
 *  the object (or an array holding it) is handed to, from which the path climbs on. */
function fromProperty(file: string, sf: ts.SourceFile, prop: ts.ObjectLiteralElementLike, steps: Step[], seen: Set<ts.Node>): Path[] {
  const obj = prop.parent as ts.ObjectLiteralExpression;
  const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : prop.name?.getText(sf);
  if (name === "onSelect") return [{ file, sf, steps, trigger: { kind: "item", item: obj } }];
  let holder: ts.Node = obj;
  let up = outer(holder);
  while (up && (ts.isArrayLiteralExpression(up) || ts.isSpreadElement(up))) { holder = up; up = outer(holder); }
  if (up && ts.isCallExpression(up) && up.arguments.some((a) => a === holder || within(holder, a))) {
    return climb(file, sf, up, steps, seen);
  }
  return [{ file, sf, steps, trigger: { kind: "other", at: prop, what: `property ${name}` } }];
}

/** Every path from `node` up to a trigger, within one file. */
function climb(file: string, sf: ts.SourceFile, node: ts.Node, steps: Step[], seen: Set<ts.Node>): Path[] {
  let h: ts.Node | undefined = node.parent;
  while (h && !FN_LIKE(h)) {
    if (ts.isJsxAttribute(h)) return [{ file, sf, steps, trigger: attrTrigger(h) }];
    h = h.parent;
  }
  if (!h) return [{ file, sf, steps, trigger: { kind: "other", at: node, what: "module scope" } }];
  if (seen.has(h)) return [];
  const next = [...steps, { fn: h, at: node }];
  const name = fnName(h);
  if (name === undefined) {
    const p = outer(h);
    if (p && ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent)) {
      return [{ file, sf, steps: next, trigger: attrTrigger(p.parent) }];
    }
    if (p && (ts.isPropertyAssignment(p) && p.initializer === h || ts.isMethodDeclaration(h) && ts.isObjectLiteralExpression(h.parent))) {
      return fromProperty(file, sf, (ts.isMethodDeclaration(h) ? h : p) as ts.ObjectLiteralElementLike, next, new Set([...seen, h]));
    }
    if (p && ts.isCallExpression(p) && p.arguments.some((a) => a === h || within(h, a))) {
      const callee = ts.isIdentifier(p.expression) ? p.expression.text : null;
      if (callee === "useEffect" || callee === "useLayoutEffect") {
        return [{ file, sf, steps: next, trigger: { kind: "effect", at: p, what: callee } }];
      }
      return climb(file, sf, p, next, new Set([...seen, h]));
    }
    return climb(file, sf, h, next, new Set([...seen, h]));
  }
  if (/^[A-Z]/.test(name)) {
    return [{ file, sf, steps: next, trigger: { kind: "render", at: node, what: `the body of ${name}` } }];
  }
  const scope = scopeOf(h);
  const refs = descendants(scope, (n) => ts.isIdentifier(n) && n.text === name && !within(n, h as ts.Node)
    && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n)
    && !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n)
    && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
    && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)
    && !(ts.isBindingElement(n.parent))) as ts.Identifier[];
  const live = refs.filter((r) => {
    // A dependency list names the function without calling it.
    const arr = outer(r);
    if (arr && ts.isArrayLiteralExpression(arr)) {
      const call = outer(arr);
      if (call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && HOOK_DEPS.has(call.expression.text)
        && call.arguments[1] === arr) return false;
    }
    return true;
  });
  if (live.length === 0) return [{ file, sf, steps: next, trigger: { kind: "unreferenced", at: h, what: name } }];
  const seenNext = new Set([...seen, h]);
  return live.flatMap((r) => {
    if (ts.isShorthandPropertyAssignment(r.parent)) return fromProperty(file, sf, r.parent, next, seenNext);
    const holder = outer(r);
    if (holder && ts.isPropertyAssignment(holder) && holder.initializer === r) return fromProperty(file, sf, holder, next, seenNext);
    return climb(file, sf, r, next, seenNext);
  });
}

// ---------------------------------------------------------------------------------------------
// VERDICTS
// ---------------------------------------------------------------------------------------------

const CLICKS = new Set(["onClick", "onSubmit", "onDoubleClick"]);
const NOT_CLICKS = new Set([
  "onChange", "onBlur", "onKeyDown", "onKeyUp", "onInput", "onFocus", "onPaste", "onDrop",
]);
/** Components that draw one `<button>` and hand it their own `onClick` and `disabled` (pinned
 *  below): their `onClick` is a click, judged by the `disabled` they are handed. */
const CLICK_WRAPPERS = new Set(["DangerButton"]);
const ASKS = new Set(["askConfirm", "askReason", "askDiscard", "askPassword"]);

type Verdict = "held" | "asked" | "keyed" | "save" | "not a click" | "unguarded" | "unclassified";
type Judged = { verdict: Verdict; where: string; why: string };

const tagName = (el: ts.JsxOpeningLikeElement): string => el.tagName.getText();

function attrValue(el: ts.JsxOpeningLikeElement, name: string): ts.Expression | null | undefined {
  for (const a of el.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === name) {
      if (!a.initializer) return null; // a bare `disabled` is `true`
      if (ts.isJsxExpression(a.initializer)) return a.initializer.expression ?? null;
      return null;
    }
  }
  // A spread may carry it (`{...moveGate(canEdit, idx, rows.length, -1)}`): read as the spread's
  // expression, which over-matches in the direction of finding a state, never of hiding one.
  const spread = el.attributes.properties.find(ts.isJsxSpreadAttribute);
  return spread ? spread.expression : undefined;
}

function itemProp(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

/** The identifiers an expression reads, receivers included, property names not. */
function readsOf(expr: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      if (p && ts.isPropertyAccessExpression(p) && p.name === n) return;
      out.push(n);
      return;
    }
    if (FN_LIKE(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return out;
}

/** The declaration an identifier names in scope: the nearest enclosing block holding a `const`
 *  (or a destructured `const [a, b]`) of that name, or a parameter's binding. */
function declarationOf(id: ts.Identifier): ts.Node | undefined {
  for (let s: ts.Node | undefined = id.parent; s; s = s.parent) {
    const found = descendants(s, (n) => (ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isParameter(n))
      && n.name.kind === ts.SyntaxKind.Identifier && (n.name as ts.Identifier).text === id.text
      // only declarations whose own scope is `s`: not one nested in an inner function
      && !descendants(s, FN_LIKE).some((f) => f !== s && within(n, f) && !within(id, f)))[0];
    if (found) return found;
    if (ts.isSourceFile(s)) break;
  }
  return undefined;
}

/** What a derived `const` is computed from: its initializer, or for a destructured one
 *  (`const { disabled } = runControlState(gate, running, …)`) the whole initializer of the
 *  declaration. A state's own `useState(…)` is not a derivation. Over-matches on purpose: a
 *  derivation that takes the state as an argument is read as reading it, and the leaf that derives
 *  it holds the rest in its own tests. */
function derivedFrom(decl: ts.Node | undefined): ts.Expression | undefined {
  let n: ts.Node | undefined = decl;
  while (n && ts.isBindingElement(n)) n = n.parent.parent;
  if (!n || !ts.isVariableDeclaration(n) || !n.initializer) return undefined;
  if (ts.isCallExpression(n.initializer) && n.initializer.expression.getText() === "useState") return undefined;
  return n.initializer;
}

/** For `const [state, setState] = useState(…)`, the setter's name, else undefined. */
function setterOf(decl: ts.Node | undefined): string | undefined {
  if (!decl || !ts.isBindingElement(decl)) return undefined;
  const pattern = decl.parent;
  if (!ts.isArrayBindingPattern(pattern) || pattern.elements[0] !== decl) return undefined;
  const v = pattern.parent;
  if (!ts.isVariableDeclaration(v) || !v.initializer || !ts.isCallExpression(v.initializer)) return undefined;
  if (v.initializer.expression.getText() !== "useState") return undefined;
  const second = pattern.elements[1];
  return second && ts.isBindingElement(second) && ts.isIdentifier(second.name) ? second.name.text : undefined;
}

const callsNamed = (n: ts.Node, name: string): ts.CallExpression[] =>
  descendants(n, (d) => ts.isCallExpression(d) && ts.isIdentifier(d.expression) && d.expression.text === name) as ts.CallExpression[];

/** Is `setter` called before the path leaves step `s`: directly; through one local function the
 *  step calls first, or calls AT that point with the path's callback (the templates page's `act`,
 *  which holds and then runs what it is handed); or by the `oneShotHold` whose `run` the path sits
 *  inside? */
function setBefore(sf: ts.SourceFile, setter: string, steps: Step[]): boolean {
  return steps.some(({ fn, at }) => {
    const start = at.getStart(sf);
    const before = (c: ts.Node) => c.getEnd() <= start;
    if (callsNamed(fn, setter).some((c) => before(c) && !isFalseCall(c))) return true;
    for (const c of descendants(fn, (d) => ts.isCallExpression(d) && ts.isIdentifier(d.expression)) as ts.CallExpression[]) {
      if (!before(c) && c !== at) continue;
      const decl = declarationOf(c.expression as ts.Identifier);
      const body = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
      const local = body && FN_LIKE(body) ? body : localFunction((c.expression as ts.Identifier).text, fn);
      if (local && (callsNamed(local, setter).some((x) => !isFalseCall(x)) || holdsIn(sf, local, setter))) return true;
    }
    return descendants(fn, isRunCall).some((c) => (c === at || (c as ts.CallExpression).arguments.some((a) => within(at, a)))
      && isHoldOf(sf, c as ts.CallExpression, setter));
  });
}

const isRunCall = (d: ts.Node): boolean => ts.isCallExpression(d) && ts.isPropertyAccessExpression(d.expression)
  && d.expression.name.text === "run";

/** Is this `X.run(…)` the `run` of a `oneShotHold(setter)`? */
function isHoldOf(sf: ts.SourceFile, c: ts.CallExpression, setter: string): boolean {
  const receiver = (c.expression as ts.PropertyAccessExpression).expression;
  if (!ts.isIdentifier(receiver)) return false;
  const decl = declarationOf(receiver);
  const init = decl && ts.isBindingElement(decl) ? (decl.parent.parent as ts.VariableDeclaration).initializer
    : decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
  return !!init && callsNamed(init, "oneShotHold").some((h) => h.arguments[0]?.getText(sf) === setter);
}

/** Does this function's body run something inside a `oneShotHold(setter)`? */
const holdsIn = (sf: ts.SourceFile, fn: ts.Node, setter: string): boolean =>
  descendants(fn, isRunCall).some((c) => isHoldOf(sf, c as ts.CallExpression, setter));

const isFalseCall = (c: ts.CallExpression): boolean => {
  const a = c.arguments[0];
  return a !== undefined && (a.kind === ts.SyntaxKind.FalseKeyword || a.kind === ts.SyntaxKind.NullKeyword);
};

function localFunction(name: string, near: ts.Node): ts.Node | undefined {
  for (let s: ts.Node | undefined = near; s; s = s.parent) {
    const f = descendants(s, (n) => ts.isFunctionDeclaration(n) && n.name?.text === name)[0];
    if (f) return f;
  }
  return undefined;
}

/** A prop handoff the disabled check may look through: the child's prop names, mapped to the
 *  parent's attribute expression and the parent's half of the path. */
type Bridge = { props: Map<string, string>; param?: string; element: ts.JsxOpeningLikeElement; parentSf: ts.SourceFile; parentSteps: Step[] };

/** Does `disabled` read a state set before the request goes out? */
function heldBy(sf: ts.SourceFile, disabled: ts.Expression | null | undefined, steps: Step[], bridge?: Bridge, depth = 0): string | null {
  if (disabled === undefined || disabled === null) return null;
  if (bridge?.param) {
    // `props.disabled` in a component that takes `props` whole.
    for (const a of descendants(disabled, ts.isPropertyAccessExpression).concat(ts.isPropertyAccessExpression(disabled) ? [disabled] : []) as ts.PropertyAccessExpression[]) {
      if (!ts.isIdentifier(a.expression) || a.expression.text !== bridge.param) continue;
      const via = heldBy(bridge.parentSf, attrValue(bridge.element, a.name.text), bridge.parentSteps, undefined, depth + 1);
      if (via) return `${a.name.text} = ${via}`;
    }
  }
  for (const id of readsOf(disabled)) {
    const decl = declarationOf(id);
    const setter = setterOf(decl);
    if (setter && setBefore(sf, setter, steps)) return id.text;
    const derived = derivedFrom(decl);
    if (derived && depth < 3) {
      const via = heldBy(sf, derived, steps, bridge, depth + 1);
      if (via) return `${id.text} (${via})`;
    }
    if (bridge && bridge.props.has(id.text)) {
      const parentExpr = attrValue(bridge.element, bridge.props.get(id.text) as string);
      const via = heldBy(bridge.parentSf, parentExpr, bridge.parentSteps, undefined, depth + 1);
      if (via) return `${id.text} = ${via}`;
    }
  }
  return null;
}

function askedOn(sf: ts.SourceFile, steps: Step[]): boolean {
  return steps.some(({ fn, at }) => descendants(fn, (d) => ts.isCallExpression(d) && ts.isIdentifier(d.expression)
    && ASKS.has(d.expression.text)).some((c) => {
    if (c.getEnd() <= at.getStart(sf)) return ts.isAwaitExpression(outer(c)) || isAwaitedInCondition(c);
    return c === at || (c as ts.CallExpression).arguments.some((a) => within(at, a)); // the request is inside the ask
  }));
}
const isAwaitedInCondition = (c: ts.Node): boolean => {
  const p = outer(c);
  return !!p && ts.isPrefixUnaryExpression(p) && ts.isAwaitExpression(outer(p));
};

/** Does the request carry a `clientRequestId` a second click would send again? A key minted with
 *  `newId()` in a function on the path is minted again by the next click, so it is not one. */
function keyedOn(sf: ts.SourceFile, request: ts.CallExpression, steps: Step[]): boolean {
  const props = descendants(request, (d) => (ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d))
    && d.name.getText(sf) === "clientRequestId") as (ts.PropertyAssignment | ts.ShorthandPropertyAssignment)[];
  if (props.length === 0) return false;
  return props.every((p) => {
    const value = ts.isPropertyAssignment(p) ? p.initializer : p.name;
    if (ts.isCallExpression(value)) return false;
    if (!ts.isIdentifier(value)) return true;
    const decl = declarationOf(value);
    const init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
    const minted = !!init && callsNamed(init.parent, "newId").length > 0;
    return !(minted && steps.some((s) => within(decl as ts.Node, s.fn)));
  });
}

function judgeClick(path: Path, request: ts.CallExpression, disabled: ts.Expression | null | undefined, bridge?: Bridge): Judged {
  const where = `${path.file}:${lineOf(path.sf, path.trigger.kind === "attr" ? path.trigger.attr : path.trigger.kind === "item" ? path.trigger.item : path.trigger.at)}`;
  if (askedOn(path.sf, path.steps) || (bridge && askedOn(bridge.parentSf, bridge.parentSteps))) {
    return { verdict: "asked", where, why: "a modal ask before the request" };
  }
  const reqSf = request.getSourceFile();
  if (keyedOn(reqSf, request, bridge ? bridge.parentSteps : path.steps)) {
    return { verdict: "keyed", where, why: "a clientRequestId a retry sends again" };
  }
  const by = heldBy(path.sf, disabled, path.steps, bridge);
  if (by) return { verdict: "held", where, why: `disabled reads ${by}` };
  return { verdict: "unguarded", where, why: disabled === undefined ? "no disabled= to hold it" : "disabled= reads no state set before the request" };
}

/** The component a JSX tag names, and its file: declared in this file, or imported from a local one. */
function componentOf(file: string, sf: ts.SourceFile, tag: string): { file: string; sf: ts.SourceFile; fn: ts.Node } | null {
  const find = (s: ts.SourceFile): ts.Node | undefined => {
    for (const st of s.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === tag) return st;
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === tag && d.initializer && FN_LIKE(d.initializer)) return d.initializer;
        }
      }
    }
    return undefined;
  };
  const here = find(sf);
  if (here) return { file, sf, fn: here };
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
    const spec = st.importClause.namedBindings.elements.find((e) => e.name.text === tag);
    if (!spec) continue;
    const target = resolveLocalModule(ROOT, file, (st.moduleSpecifier as ts.StringLiteral).text);
    if (!target) return null;
    const tsf = parse(target);
    const fn = find(tsf);
    return fn ? { file: target, sf: tsf, fn } : null;
  }
  return null;
}

/** The child's local names for its destructured props, keyed back to the prop names; or, for a
 *  component that takes `props` whole, that parameter's name. */
function propNames(fn: ts.Node): { names: Map<string, string>; param?: string } {
  const names = new Map<string, string>();
  const param = (fn as ts.FunctionLikeDeclaration).parameters?.[0];
  if (param && ts.isIdentifier(param.name)) {
    // `const { onSave, disabled } = props;` in the body names its props as a pattern would.
    const whole = param.name.text;
    const body = (fn as ts.FunctionLikeDeclaration).body;
    for (const d of body ? descendants(body, ts.isVariableDeclaration) as ts.VariableDeclaration[] : []) {
      if (!ts.isObjectBindingPattern(d.name) || !d.initializer || d.initializer.getText() !== whole) continue;
      for (const el of d.name.elements) {
        if (!ts.isIdentifier(el.name)) continue;
        names.set(el.name.text, el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text);
      }
    }
    return { names, param: whole };
  }
  if (!param || !ts.isObjectBindingPattern(param.name)) return { names };
  for (const el of param.name.elements) {
    if (!ts.isIdentifier(el.name)) continue;
    const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
    names.set(el.name.text, prop);
  }
  return { names };
}

function judge(path: Path, request: ts.CallExpression, hop = 0, bridgeIn?: Bridge): Judged[] {
  const t = path.trigger;
  const where = (n: ts.Node) => `${path.file}:${lineOf(path.sf, n)}`;
  if (t.kind === "item") return [judgeClick(path, request, itemProp(t.item, "disabled"), bridgeIn)];
  if (t.kind !== "attr") return [{ verdict: "unclassified", where: where(t.at), why: `${t.kind}: ${t.what}` }];
  const tag = tagName(t.element);
  const attr = t.attr.name.getText();
  const intrinsic = /^[a-z]/.test(tag);
  if (NOT_CLICKS.has(attr)) return [{ verdict: "not a click", where: where(t.attr), why: `${tag} ${attr}` }];
  if (tag === "SaveButton" && (attr === "onSave" || attr === "onDiscard")) {
    return [{ verdict: "save", where: where(t.attr), why: `SaveButton ${attr}` }];
  }
  if (CLICKS.has(attr) && (intrinsic || CLICK_WRAPPERS.has(tag))) {
    return [judgeClick(path, request, attrValue(t.element, "disabled"), bridgeIn)];
  }
  if (hop > 0 && bridgeIn && (askedOn(path.sf, path.steps) || askedOn(bridgeIn.parentSf, bridgeIn.parentSteps))) {
    return [{ verdict: "asked", where: where(t.attr), why: "a modal ask before the request" }];
  }
  if (intrinsic || hop > 0) {
    return [{ verdict: "unclassified", where: where(t.attr), why: `${tag} ${attr}${hop > 0 ? " (a second hop)" : ""}` }];
  }
  // A handler handed to another component: one hop into it.
  const child = componentOf(path.file, path.sf, tag);
  if (!child) return [{ verdict: "unclassified", where: where(t.attr), why: `${tag} ${attr}: the component could not be found` }];
  const { names, param } = propNames(child.fn);
  const local = [...names].find(([, prop]) => prop === attr)?.[0];
  const body = (child.fn as ts.FunctionLikeDeclaration).body;
  const refs: ts.Node[] = !body ? []
    : local ? descendants(body, (n) => ts.isIdentifier(n) && n.text === local
      && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !ts.isBindingElement(n.parent))
    : param ? descendants(body, (n) => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)
      && n.expression.text === param && n.name.text === attr)
    : [];
  if (refs.length === 0) return [{ verdict: "unclassified", where: where(t.attr), why: `${tag} ${attr}: the prop could not be followed` }];
  const bridge: Bridge = { props: names, param, element: t.element, parentSf: path.sf, parentSteps: path.steps };
  return refs.flatMap((r) => climb(child.file, child.sf, r, [], new Set()))
    .flatMap((p) => judge(p, request, hop + 1, bridge));
}

type Row = Judged & { request: string; site: string };

/** Every (request, trigger) pair in these sources with its verdict, and the site each request
 *  sits in, which an exemption names: its first named function, or its callee when it has none. */
function censusOf(sources: { file: string; sf: ts.SourceFile }[]): Row[] {
  const rows: Row[] = [];
  for (const { file, sf } of sources) {
    for (const request of writeCalls(sf)) {
      const paths = climb(file, sf, request, [], new Set());
      const named = paths[0]?.steps.map((st) => fnName(st.fn)).find((n) => n !== undefined)
        ?? `${request.expression.getText(sf)}(…)`;
      const site = `${file}#${named}`;
      for (const p of paths) {
        for (const j of judge(p, request)) rows.push({ ...j, request: `${file}:${lineOf(sf, request)}`, site });
      }
    }
  }
  return rows;
}
const census = (): Row[] => censusOf(clientFiles().map((file) => ({ file, sf: parse(file) })));
/** One synthetic source, for the detectors' own cases. Components it hands a handler to must be
 *  declared in it. */
const censusOfSource = (src: string): Row[] => censusOf([{ file: "candidate.tsx", sf: parse("candidate.tsx", src) }]);

const BAD: Verdict[] = ["unguarded", "unclassified"];

// ---------------------------------------------------------------------------------------------
// THE EXEMPTIONS
// ---------------------------------------------------------------------------------------------

/** The kinds of claim an exemption makes. Each is a reason the click may send its write again, or
 *  a trigger that is not a click at all, which this sweep cannot see is one. */
const KINDS = [
  "queued",        // a click that enqueues a run on the page's save queue: each click is its own run
  "whole-value",   // a write of one whole value: a second click sends the same value again
  "deduped",       // a wrapper that refuses a request already out under the same key
  "session",       // signing in or out: a second click opens or ends a session, refusing nothing
  "keyed in a leaf", // the body, built in a leaf, carries a clientRequestId a retry sends again
  "held elsewhere", // held by a state this sweep cannot follow (a context, a ref)
  "not a click",   // reached from an effect, a ref or a hook, not from a click
] as const;
type Kind = typeof KINDS[number];

/** Keyed by the site (`file#function`), with how many unguarded or unclassified pairs it covers:
 *  exactly that many, so a new trigger of an exempt site, or a new request a callee-keyed site
 *  (`#api(…)`) would otherwise take in, reds the count instead of riding the exemption. */
const EXEMPTIONS = new Map<string, { kind: Kind; pairs: number; reason: string }>([
  ["src/app/admin/step-codes/page.tsx#run", { kind: "queued", pairs: 8,
    reason: "A selected code's field edits (move, remove, Add suggestion) enqueue on `enqueueFieldOp`, which composes each run "
      + "from the fields the run before it left; a second click is a second edit, as the plan's step 4 rules." }],
  ["src/app/admin/templates/page.tsx#rename", { kind: "whole-value", pairs: 1,
    reason: "Rename PATCHes the whole name; a second click sends the same name, which the server takes again." }],
  ["src/app/parts/[id]/InspectionsSection.tsx#move", { kind: "whole-value", pairs: 2,
    reason: "A move PUTs the whole order of the rows as the click's render holds it; a second click sends that order again." }],
  ["src/app/parts/[id]/PricingSection.tsx#move", { kind: "whole-value", pairs: 2,
    reason: "A move PUTs the whole order of the prices as the click's render holds it; a second click sends that order again." }],
  ["src/app/customers/[id]/page.tsx#call", { kind: "deduped", pairs: 3,
    reason: "`call` keys each request by method and path in `inFlight` and refuses one already out under that key." }],
  ["src/app/customers/[id]/page.tsx#call(…)", { kind: "deduped", pairs: 3,
    reason: "The address and contact buttons send through `call`, which refuses a request already out under its key." }],
  ["src/app/login/page.tsx#submit", { kind: "session", pairs: 1,
    reason: "A second sign-in click opens a second session and refuses nothing." }],
  ["src/components/Shell.tsx#signOut", { kind: "session", pairs: 1,
    reason: "A second sign-out click ends a session already ended and refuses nothing." }],
  ["src/app/shipping/new/NewShipment.tsx#retryOriginal", { kind: "keyed in a leaf", pairs: 1,
    reason: "Retry original submission resends the original submission's payload (`prepareUnknownRetry`, draft-store.ts), "
      + "which carries the draft's own clientRequestId, so the server answers a second retry as the same write." }],
  ["src/app/orders/[id]/DocumentsSection.tsx#print", { kind: "held elsewhere", pairs: 3,
    reason: "The traveler print controller refuses a print while `printInFlight` holds and hands `printing` to its buttons "
      + "through TravelerContext; its automatic print runs from an effect once per intent." }],
  ["src/app/orders/new/page.tsx#submitOnce", { kind: "not a click", pairs: 1,
    reason: "Reached from the page body through `handleSaveRef`, which R12's waiting Save calls once its plan lands; the Save "
      + "click itself is judged on its own path." }],
  ["src/app/orders/new/page.tsx#api(…)", { kind: "not a click", pairs: 1,
    reason: "The load plan's preview, a read-only POST sent from an effect after the debounce." }],
  ["src/app/parts/[id]/ProcessPreviewDialog.tsx#trackedFetch(…)", { kind: "not a click", pairs: 1,
    reason: "The traveler preview, a read-only POST sent from an effect." }],
  ["src/app/admin/templates/[id]/edit/PreviewPane.tsx#runPreview", { kind: "not a click", pairs: 1,
    reason: "The Design tab's live page (PR C of #926, Task 6), a read-only preview POST its effect sends once the config "
      + "settles, through a latest gate; the Preview tab's Generate preview click is judged on its own path." }],
  ["src/app/orders/new/use-order-autosave.ts#api(…)", { kind: "not a click", pairs: 2,
    reason: "The draft autosave transport's PUT and DELETE, sent by the autosave, never by a click." }],
  ["src/components/ReferenceTable.tsx#savePatch", { kind: "not a click", pairs: 6,
    reason: "Reached through the inline boxes' `useInlineBox`, which saves on leaving the box and on Enter." }],
]);

describe("#720 — every click that sends a write holds, asks, or carries a stable key", () => {
  const rows = census();

  it("finds enough of the client tree to be a real census, not a vacuous pass", () => {
    expect(new Set(rows.map((r) => r.request)).size).toBeGreaterThan(120);
    expect(rows.filter((r) => r.verdict === "held").length).toBeGreaterThan(50);
    expect(rows.filter((r) => r.verdict === "asked").length).toBeGreaterThan(30);
    expect(rows.filter((r) => r.verdict === "not a click").length).toBeGreaterThan(200);
  });

  it("leaves no click unguarded and no trigger unclassified outside a written exemption", () => {
    const open = [...new Set(rows.filter((r) => BAD.includes(r.verdict) && !EXEMPTIONS.has(r.site))
      .map((r) => `${r.verdict}: ${r.site} (${r.where}, ${r.why})`))];
    expect(open).toEqual([]);
  });

  it("keeps every exemption in use, covering exactly its pinned pairs, of a named kind, with a reason", () => {
    const covered = new Map<string, number>();
    for (const r of rows.filter((x) => BAD.includes(x.verdict))) covered.set(r.site, (covered.get(r.site) ?? 0) + 1);
    for (const [site, { kind, pairs, reason }] of EXEMPTIONS) {
      expect(covered.get(site) ?? 0, `${site} covers a different number of pairs than it pins`).toBe(pairs);
      expect(KINDS).toContain(kind);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it("pins how many exemptions exist, so a new one is a decision", () => {
    expect(EXEMPTIONS.size).toBe(16);
  });

  it("holds each of the eighteen controls #720 ported", () => {
    const held = (site: string) => rows.filter((r) => r.site === site && CLICKS_OF(r)).map((r) => r.verdict);
    for (const site of [
      "src/app/quotes/[id]/QuoteDetail.tsx#attachPart",
      "src/app/admin/templates/page.tsx#createTemplate",
      "src/app/admin/templates/page.tsx#openDraft",
      "src/app/admin/templates/page.tsx#discardDraft",
      "src/app/admin/templates/page.tsx#publish",
      "src/app/admin/templates/page.tsx#setDefault",
      "src/app/admin/users/page.tsx#create",
      "src/app/admin/roles/page.tsx#create",
      "src/app/admin/step-codes/page.tsx#add",
      "src/app/admin/part-fields/page.tsx#add",
      "src/app/admin/surcharges/page.tsx#add",
      "src/app/customers/page.tsx#add",
      "src/app/parts/page.tsx#add",
      "src/components/ReferenceTable.tsx#add",
      "src/app/parts/[id]/SpecsSection.tsx#add",
      "src/app/parts/[id]/SpecsSection.tsx#remove",
      "src/app/page.tsx#saveView",
    ]) {
      const verdicts = held(site);
      expect(verdicts.length, `${site} has no click`).toBeGreaterThan(0);
      expect(verdicts.every((v) => v === "held"), `${site}: ${verdicts.join(", ")}`).toBe(true);
    }
  });

  it("reads DangerButton's onClick as a click because it hands onClick and disabled to its one button", () => {
    const sf = parse("src/components/DangerButton.tsx");
    const buttons = descendants(sf, (n) => (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n))
      && n.tagName.getText() === "button") as ts.JsxOpeningLikeElement[];
    expect(buttons).toHaveLength(1);
    expect(attrValue(buttons[0], "onClick")?.getText(sf)).toBe("onClick");
    expect(attrValue(buttons[0], "disabled")?.getText(sf)).toBe("disabled");
  });
});

/** A row whose trigger is a click (a verdict only a click can take). */
const CLICKS_OF = (r: Row): boolean => r.verdict === "held" || r.verdict === "asked" || r.verdict === "keyed" || r.verdict === "unguarded";

describe("#720 — the detectors themselves, on sources written to break them", () => {
  const verdicts = (src: string) => censusOfSource(src).map((r) => r.verdict);
  const page = (body: string, jsx: string) => `
    import { useState } from "react";
    import { oneShotHold } from "@/lib/single-flight";
    export default function Page() {
      ${body}
      return (<div>${jsx}</div>);
    }`;

  it("holds a request inside a oneShotHold's run whose state disabled= reads", () => {
    expect(verdicts(page(`
      const [adding, setAdding] = useState(false);
      const [addHold] = useState(() => oneShotHold(setAdding));
      async function add() { await addHold.run(async () => { await api("/api/x", { method: "POST" }); }); }`,
    `<button onClick={add} disabled={adding}>Add</button>`))).toEqual(["held"]);
  });

  it("refuses the same hold when disabled= reads something else, or when the request is outside run", () => {
    expect(verdicts(page(`
      const [adding, setAdding] = useState(false);
      const [addHold] = useState(() => oneShotHold(setAdding));
      async function add() { await addHold.run(async () => { await api("/api/x", { method: "POST" }); }); }`,
    `<button onClick={add} disabled={!allowed}>Add</button>`))).toEqual(["unguarded"]);
    expect(verdicts(page(`
      const [adding, setAdding] = useState(false);
      const [addHold] = useState(() => oneShotHold(setAdding));
      async function add() { await api("/api/x", { method: "POST" }); await addHold.run(async () => {}); }`,
    `<button onClick={add} disabled={adding}>Add</button>`))).toEqual(["unguarded"]);
  });

  it("holds a setter called before the request, directly or through one local helper, but not after it", () => {
    expect(verdicts(page(`
      const [busy, setBusy] = useState(false);
      async function go() { setBusy(true); try { await api("/api/x", { method: "PUT" }); } finally { setBusy(false); } }`,
    `<button onClick={() => void go()} disabled={busy}>Go</button>`))).toEqual(["held"]);
    expect(verdicts(page(`
      const [busy, setBusy] = useState(null);
      function hold(kind) { setBusy(kind); }
      async function go() { hold("go"); await api("/api/x", { method: "PUT" }); }`,
    `<button onClick={go} disabled={busy !== null}>Go</button>`))).toEqual(["held"]);
    expect(verdicts(page(`
      const [busy, setBusy] = useState(false);
      async function go() { await api("/api/x", { method: "PUT" }); setBusy(true); }`,
    `<button onClick={go} disabled={busy}>Go</button>`))).toEqual(["unguarded"]);
    expect(verdicts(page(`
      const [busy, setBusy] = useState(false);
      async function go() { setBusy(false); await api("/api/x", { method: "PUT" }); }`,
    `<button onClick={go} disabled={busy}>Go</button>`))).toEqual(["unguarded"]);
  });

  it("reads a derived disabled through a const, a destructure and a leaf call", () => {
    expect(verdicts(page(`
      const [running, setRunning] = useState(false);
      const { disabled: off } = controlState(gate, running);
      async function go() { setRunning(true); await api("/api/x", { method: "POST" }); }`,
    `<button onClick={go} disabled={off}>Go</button>`))).toEqual(["held"]);
  });

  it("accepts a modal ask awaited before the request, or around it, and not one sent after", () => {
    expect(verdicts(page(`
      async function drop() { if (!(await askConfirm({}))) return; await api("/api/x", { method: "DELETE" }); }`,
    `<button onClick={drop}>Delete</button>`))).toEqual(["asked"]);
    expect(verdicts(page(`
      function setPassword() { void askPassword({ submit: async () => api("/api/x", { method: "PUT" }) }); }`,
    `<button onClick={setPassword}>Set password</button>`))).toEqual(["asked"]);
    expect(verdicts(page(`
      async function drop() { await api("/api/x", { method: "DELETE" }); await askConfirm({}); }`,
    `<button onClick={drop}>Delete</button>`))).toEqual(["unguarded"]);
  });

  it("accepts a clientRequestId a retry sends again, never one minted per click", () => {
    expect(verdicts(page(`
      async function save() { await api("/api/x", { method: "POST", body: JSON.stringify({ clientRequestId: draft.id }) }); }`,
    `<button onClick={save}>Save</button>`))).toEqual(["keyed"]);
    expect(verdicts(page(`
      async function save() { const clientRequestId = newId(); await api("/api/x", { method: "POST", body: JSON.stringify({ clientRequestId }) }); }`,
    `<button onClick={save}>Save</button>`))).toEqual(["unguarded"]);
    expect(verdicts(page(`
      async function save() { await api("/api/x", { method: "POST", body: JSON.stringify({ clientRequestId: newId() }) }); }`,
    `<button onClick={save}>Save</button>`))).toEqual(["unguarded"]);
  });

  it("follows a handler into a component and a disabled prop back to the parent's state", () => {
    const src = `
      import { useState } from "react";
      function Bar({ onSave, saving }) { return <button onClick={onSave} disabled={saving}>Save</button>; }
      export default function Page() {
        const [saving, setSaving] = useState(false);
        async function save() { setSaving(true); await api("/api/x", { method: "POST" }); }
        return <Bar onSave={save} saving={RENDER} />;
      }`;
    expect(verdicts(src.replace("RENDER", "saving"))).toEqual(["held"]);
    expect(verdicts(src.replace("RENDER", "false"))).toEqual(["unguarded"]);
  });

  it("calls SaveButton's save a SaveButton, a blur or change trigger out of scope, and an effect unclassified", () => {
    expect(verdicts(page(`async function save() { await api("/api/x", { method: "PUT" }); }`,
      `<SaveButton onSave={save} />`))).toEqual(["save"]);
    expect(verdicts(page(`async function save() { await api("/api/x", { method: "PUT" }); }`,
      `<input onBlur={() => void save()} /><select onChange={save} />`))).toEqual(["not a click", "not a click"]);
    expect(verdicts(page(`useEffect(() => { void api("/api/x", { method: "POST" }); }, []);`, ``)))
      .toEqual(["unclassified"]);
  });

  it("treats an unreadable method as a write and a request with no method as a read", () => {
    expect(verdicts(page(`async function go() { await api("/api/x", init); }`, `<button onClick={go}>Go</button>`)))
      .toEqual(["unguarded"]);
    expect(verdicts(page(`async function go() { await api("/api/x"); await api("/api/y", { method: "GET" }); }`,
      `<button onClick={go}>Go</button>`))).toEqual([]);
  });

  it("does not take a dependency list for a call, nor a hook handed an /api/ path for a request", () => {
    expect(verdicts(page(`
      const go = useCallback(async () => { await api("/api/x", { method: "POST" }); }, []);
      useEffect(() => {}, [go]);
      const docs = useStoredDocuments("/api/x/documents", true, 0);`,
    `<button onClick={go} disabled>Go</button>`))).toEqual(["unguarded"]);
  });
});
