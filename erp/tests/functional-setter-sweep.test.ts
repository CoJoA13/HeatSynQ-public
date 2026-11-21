// A guard-fed setter is called only with a function or a guard call (#574).
//
// WHAT THIS PROVES. On every page that applies a server payload through the edit guard
// (`src/lib/use-edit-guard.ts`: `applyPayload`, `applyRows` or `capturePayload`), the state the guard
// feeds is never set from an object built out of the render's copy, and every updater it is set
// with takes the state as a plain parameter, reads it, and reads neither the render's copy nor the
// event (`target`, `currentTarget`); a value read in the handler and closed over (`patch`, `v`,
// `atFocus`, a keyed row's id) is fine. React applies queued updates in dispatch order, each over
// the previous result, and a non-functional action replaces the state outright: a payload updater
// dispatched before a keystroke built from the render's copy loses to that object, and everything
// the payload carried is gone until the next payload (#574). An updater is also replayed (Strict
// Mode, a rebased lane), so one that reads the event, or the render's copy it closed over, judges
// with stale inputs on the replay; and one that ignores its parameter (`() => next`, `(cur) =>
// next`) is the object form in a function's clothing. The compliant keystroke shapes are each
// page's pure `patchDraft`, which reads the typed text in the handler and hands the setter an
// updater over its parameter alone, and, for a keyed list cell, an updater over the rows that sets
// one field of the row whose id it closed over; tests/header-setters.test.ts proves each page's
// `patchDraft`, each header box's `onChange` and each keyed cell's, and this sweep holds the rule
// across `src/`.
//
// THE RULE, in prose. Walk every `.ts` and `.tsx` under `src/`, parsed with the TypeScript compiler
// (never pattern-matched, #188). A file is in the census when it calls a property named
// `applyPayload`, `applyRows` or `capturePayload` on any receiver, a string-literal element access
// included (a bare call of that name is not one; `ProcessStepsSection.tsx` declares its own
// `applyRows`). Every guard call must sit where a setter is fed by it: `applyPayload` and
// `applyRows` as the first argument of an identifier call, `capturePayload` as a `const`'s
// initializer; any other placement is refused, and a census file that feeds no setter fails the
// sweep. A setter is guard-fed when an identifier is called with such a guard call as its first
// argument, or with a function whose own body (a function nested in it not descended into) calls
// a property named `merge` (the order hub's composed updater over `capturePayload`, inside its
// `useCallback`). Its render copy is the first element of the `useState` array binding that
// declares the setter as its second; a guard-fed setter the walk cannot pair, or a setter name two
// bindings declare, fails the sweep. Then, for every reference to a guard-fed setter: a call whose
// first argument is neither a function nor a guard call is refused (the stale-copy object form
// among them, and a call with no argument); a function argument with no parameter, whose first
// parameter is not a plain identifier, or whose parameter is never read in its body is refused;
// a function argument whose body names the render copy, or names `target` or `currentTarget` (as
// an identifier or a string-literal element access), is refused; and a reference that is not the
// callee of a call is refused (an alias, a prop pass, a destructure), the setter's own `useState`
// binding excepted. Over every file, census or not, a `patchDraft(…)` call whose object literal
// spreads anything is refused: a child section's copy of the page's detail arrives as a prop,
// which the render-copy rule cannot name.
//
// WHAT OVER-MATCHES, AND WHAT IS NOT SEEN. The scans over an updater's body match a name wherever
// it appears, a property name included (`{ target: … }`, or a property named like the render copy,
// inside an updater is refused); a setter in a hook's dependency array is refused as uncalled; an
// updater parameter named like the render copy is refused; a guard call under an `as` cast is
// refused; and a function passed to any identifier call whose body calls a property named `merge`
// (zod's `.merge` in a `useMemo` callback, say) makes that callee "guard-fed" and fails the
// pairing. Each is a refusal or a failure, never a skip. Not seen, and stated here instead: a
// value taken from the event or the render's copy in the handler and read in the updater through
// an alias (`const t = e.target; setX((cur) => ({ ...cur, k: t.value }))`, a derived render value),
// which stales one field, not the whole payload; a parameter shadowed by a nested function's
// parameter of the same name; a `merge` call reached through a named function rather than an
// inline updater; and WHERE payloads are applied: a functional `setShipper((cur) => ({ ...cur,
// ...res.shipper }))` that bypasses the guard passes here and is use-edit-guard.ts's discipline
// (CLAUDE.md's UI paragraph), not this sweep's. The two derived site lists see only an `onChange`
// whose attribute holds the call: a handler declared outside the attribute derives nothing, and
// any inline functional `onChange` on a guard-fed setter derives as a keyed cell.
//
// THE ALLOWLIST. `ALLOWED` is keyed by file, setter and property, never by line, and every entry
// carries a reason; an entry names no rule, and a `rule` field is added with the first entry. An
// entry that matches no refusal the rule raises is stale and fails (the unsaved-registration-sweep
// shape), so a fixed site cannot leave its exemption behind. It is empty, and the rule had no
// exception on the day it landed: the walk's first run raised eight refusals, the customer page's
// keyed list cells (addresses and contacts, their setters fed through `applyRows`), whose updaters
// read the event's value inside the updater, a pre-existing shape outside #574's header sites;
// the owner ruled they be fixed here (ruling 5, 2026-10-20), and each now reads the value in the
// handler. tests/header-setters.test.ts lifts those eight cells too, and the second agreement
// check below derives them from the parsed source.
//
// THE ACCEPTED RESIDUAL. The Add-row and list forms outside the guard (eight files in `src/app` and
// `ReferenceTable.tsx`) keep the object form: no server payload lands in those drafts while they
// are typed, except each form's own post-Add reset, dispatched from a promise, which a keystroke
// into a row just submitted can lose (owner ruling 2026-10-20, Q1). They hold no guard call (the
// customer page's Add-row drafts, `setAddrDraft`/`setContactDraft`, sit in a census file but are
// fed by no guard call), so the sweep says nothing about them.
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { headerSetterSiteKeys, keyedCellSiteKeys } from "./helpers/header-setter-sites";

const SRC = join(process.cwd(), "src");

/** The guard's three apply methods: a call of one, on any receiver, puts a file in the census. */
const GUARD_METHODS = new Set(["applyPayload", "applyRows", "capturePayload"]);

/** The property a refusal with no object property behind it is keyed on. */
const NO_PROPERTY = "-";

type Allowed = { file: string; setter: string; property: string; reason: string };

/**
 * A detector false positive, or a shape the owner has accepted, keyed by file, setter and property
 * (never by line). Empty: a first entry needs a reason of at least 40 characters saying what the
 * site does, why it is kept, and what would drop the entry, and an entry that matches no refusal
 * fails the stale-entry check below.
 */
const ALLOWED: Allowed[] = [];

/** The census floor: the eight files known to call the guard at #574. A floor, not a ceiling. */
const KNOWN_CENSUS = [
  "src/app/admin/billing/page.tsx",
  "src/app/certs/[id]/CertDetail.tsx",
  "src/app/customers/[id]/page.tsx",
  "src/app/invoicing/[id]/InvoiceDetail.tsx",
  "src/app/orders/[id]/page.tsx",
  "src/app/parts/[id]/page.tsx",
  "src/app/receivables/batches/[id]/BatchDetail.tsx",
  "src/app/shipping/[id]/ShipmentDetail.tsx",
];

/** A file that declares and calls its own bare `applyRows`: the census self-test's exclusion. */
const BARE_APPLY_ROWS_FILE = "src/app/parts/[id]/ProcessStepsSection.tsx";

type Refusal = { file: string; line: number; setter: string; property: string; reason: string };
type GuardFed = { setter: string; renderCopy: string; via: "guard call" | "merge" };
type Sweep = { census: boolean; guardFed: GuardFed[]; refusals: Refusal[] };

const text = (r: Refusal) => `${r.file}:${r.line} ${r.setter} — ${r.reason}`;

function parse(file: string, src: string): ts.SourceFile {
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Every node under `root` (itself included) that `pred` accepts, in source order. */
function all<T extends ts.Node>(root: ts.Node, pred: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node): void => {
    if (pred(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** The guard method a call names: `editGuard.applyPayload(…)` or `editGuard["applyPayload"](…)`. */
function guardMethod(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
    : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
      ? callee.argumentExpression.text : undefined;
  return name !== undefined && GUARD_METHODS.has(name) ? name : undefined;
}
/** A call of a property named `applyPayload`, `applyRows` or `capturePayload`, on any receiver. */
const isGuardCall = (node: ts.Node): node is ts.CallExpression => guardMethod(node) !== undefined;

/** The two event names an updater must not read (use-edit-guard.ts's rule, #574). */
const EVENT_NAMES = new Set(["target", "currentTarget"]);
const EVENT_READ = "the updater reads target or currentTarget (an event read inside an updater)";

/** Does `body` read the name? A property name (`obj.cur`, `{ cur: 1 }`) and a declaration (a
 *  nested parameter, `const cur`, a binding element) are not reads; a shorthand `{ cur }` is one.
 *  A nested function's parameter of the same name shadows, and its uses still count: a residual. */
function readsName(body: ts.Node, name: string): boolean {
  return all(body, ts.isIdentifier).some((id) => id.text === name
    && !(ts.isPropertyAccessExpression(id.parent) && id.parent.name === id)
    && !(ts.isPropertyAssignment(id.parent) && id.parent.name === id)
    && !(ts.isParameter(id.parent) && id.parent.name === id)
    && !(ts.isVariableDeclaration(id.parent) && id.parent.name === id)
    && !(ts.isBindingElement(id.parent) && id.parent.name === id));
}

const isFunctionArg = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node);

/**
 * Does this function's OWN body call a property named `merge`? The hub's composed updater shape,
 * `(prev) => captured.merge(prev, …)`. A function nested inside the body is not descended into: the
 * hub's `load` is itself a `useCallback` callback holding that updater, and a walk that descended
 * would read `useCallback` as the setter and fail to pair it.
 */
function callsMerge(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || isFunctionArg(node) || ts.isFunctionDeclaration(node)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "merge") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}

/** The property name text of an object-literal member, `[expr]` for a computed one. */
function propertyText(name: ts.PropertyName): string {
  return ts.isComputedPropertyName(name) ? `[${name.expression.getText()}]` : name.text;
}

/** The name of the nearest enclosing object-literal property assignment below `stop`, if any. */
function enclosingProperty(node: ts.Node, stop: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n && n !== stop; n = n.parent) {
    if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) return propertyText(n.name);
  }
  return NO_PROPERTY;
}

/** The first non-spread property of an object literal first argument, else the marker. */
function firstProperty(arg: ts.Node | undefined): string {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return NO_PROPERTY;
  const named = arg.properties.find((p) => !ts.isSpreadAssignment(p) && p.name !== undefined);
  return named?.name ? propertyText(named.name) : NO_PROPERTY;
}

/**
 * The sweep over one parsed source. Pure over its inputs, so the synthetic self-tests below feed it
 * an in-memory file and the real walk feeds it every file under `src/`.
 */
function sweep(file: string, src: string): Sweep {
  const sf = parse(file, src);
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const calls = all(sf, ts.isCallExpression);
  if (!calls.some(isGuardCall)) return { census: false, guardFed: [], refusals: [] };

  // Every guard call sits where a setter is fed by it, or the setter it was meant for is swept not
  // at all: `applyPayload`/`applyRows` as the first argument of an identifier call, `capturePayload`
  // as a `const`'s initializer (its `merge` is then found in an updater). Anything else is refused.
  const refusals: Refusal[] = [];
  for (const call of calls.filter(isGuardCall)) {
    const method = guardMethod(call)!;
    const parent = call.parent;
    const placed = method === "capturePayload"
      ? ts.isVariableDeclaration(parent) && parent.initializer === call
      : ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.arguments[0] === call;
    if (!placed) refusals.push({ file, line: line(call), setter: call.expression.getText(sf), property: NO_PROPERTY,
      reason: method === "capturePayload"
        ? "a capturePayload call that is not a const's initializer (its merge cannot be paired with a setter)"
        : `an ${method} call that is not the first argument of a setter call (no setter is fed by it)` });
  }

  // The guard-fed setters: an identifier called with a guard call, or with a merge-calling function.
  const fed = new Map<string, GuardFed["via"]>();
  for (const call of calls) {
    if (!ts.isIdentifier(call.expression) || call.arguments.length === 0) continue;
    const first = call.arguments[0];
    if (isGuardCall(first)) fed.set(call.expression.text, fed.get(call.expression.text) ?? "guard call");
    else if (isFunctionArg(first) && callsMerge(first)) fed.set(call.expression.text, fed.get(call.expression.text) ?? "merge");
  }
  if (fed.size === 0) {
    throw new Error(`${file}: calls the guard but feeds no setter the sweep can see`
      + (refusals.length ? ` (${refusals.map(text).join("; ")})` : ""));
  }

  // Each one's render copy: the first element of the useState binding that declares the setter.
  const bindings = new Map<string, { renderCopy: string; element: ts.BindingElement }>();
  for (const decl of all(sf, ts.isVariableDeclaration)) {
    if (!ts.isArrayBindingPattern(decl.name) || !decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
    const callee = decl.initializer.expression;
    const isUseState = (ts.isIdentifier(callee) && callee.text === "useState")
      || (ts.isPropertyAccessExpression(callee) && callee.name.text === "useState");
    if (!isUseState) continue;
    const [copy, setter] = decl.name.elements;
    if (!copy || !setter || !ts.isBindingElement(copy) || !ts.isBindingElement(setter)) continue;
    if (!ts.isIdentifier(copy.name) || !ts.isIdentifier(setter.name)) continue;
    if (bindings.has(setter.name.text)) throw new Error(`${file}: two useState bindings declare ${setter.name.text}; the sweep pairs a setter by name`);
    bindings.set(setter.name.text, { renderCopy: copy.name.text, element: setter });
  }
  const guardFed: GuardFed[] = [];
  for (const [setter, via] of fed) {
    const binding = bindings.get(setter);
    if (!binding) throw new Error(`${file}: the guard-fed setter ${setter} has no useState binding the sweep can pair it with`);
    guardFed.push({ setter, renderCopy: binding.renderCopy, via });
  }

  // The rule, over every reference to each guard-fed setter.
  for (const { setter, renderCopy } of guardFed) {
    const binding = bindings.get(setter)!;
    for (const id of all(sf, ts.isIdentifier)) {
      if (id.text !== setter) continue;
      if (id.parent === binding.element) continue;             // its own useState binding
      const parent = id.parent;
      if (!ts.isCallExpression(parent) || parent.expression !== id) {
        refusals.push({ file, line: line(id), setter, property: NO_PROPERTY,
          reason: "referenced without being called (an alias, a prop pass or a destructure)" });
        continue;
      }
      const first = parent.arguments[0];
      if (first && isGuardCall(first)) continue;
      if (!first || !isFunctionArg(first)) {
        refusals.push({ file, line: line(parent), setter, property: firstProperty(first),
          reason: "called with a first argument that is neither a function nor a guard call" });
        continue;
      }
      const param = first.parameters[0];
      if (!param) {
        refusals.push({ file, line: line(first), setter, property: NO_PROPERTY,
          reason: "the updater takes no parameter (it ignores the state it is applied over)" });
      } else if (!ts.isIdentifier(param.name) || param.dotDotDotToken) {
        refusals.push({ file, line: line(first), setter, property: NO_PROPERTY,
          reason: "the updater's first parameter is not a plain identifier (destructure it in the body)" });
      } else if (!readsName(first.body, param.name.text)) {
        refusals.push({ file, line: line(first), setter, property: NO_PROPERTY,
          reason: `the updater never reads its parameter ${param.name.text}` });
      }
      for (const ref of all(first.body, ts.isIdentifier)) {
        if (!EVENT_NAMES.has(ref.text)) continue;
        refusals.push({ file, line: line(ref), setter, property: enclosingProperty(ref, first), reason: EVENT_READ });
      }
      for (const access of all(first.body, ts.isElementAccessExpression)) {
        if (!ts.isStringLiteralLike(access.argumentExpression) || !EVENT_NAMES.has(access.argumentExpression.text)) continue;
        refusals.push({ file, line: line(access), setter, property: enclosingProperty(access, first), reason: EVENT_READ });
      }
      for (const ref of all(first.body, ts.isIdentifier)) {
        if (ref.text !== renderCopy) continue;
        refusals.push({ file, line: line(ref), setter, property: enclosingProperty(ref, first),
          reason: `the updater names the render copy ${renderCopy}` });
      }
    }
  }
  return { census: true, guardFed, refusals };
}

/**
 * Every `onChange` attribute in a parsed source that calls the bare `patchDraft`, as `file|property`
 * for the one property each call patches. Fails closed: a `patchDraft` call in an `onChange` whose
 * argument is not an object literal of exactly one property is an error, not a skip.
 */
function patchDraftSites(file: string, src: string): string[] {
  const sf = parse(file, src);
  const out: string[] = [];
  for (const attr of all(sf, ts.isJsxAttribute)) {
    if (!ts.isIdentifier(attr.name) || attr.name.text !== "onChange" || !attr.initializer) continue;
    for (const call of all(attr.initializer, ts.isCallExpression)) {
      if (!ts.isIdentifier(call.expression) || call.expression.text !== "patchDraft") continue;
      const arg = call.arguments[0];
      const prop = arg && ts.isObjectLiteralExpression(arg) ? arg.properties[0] : undefined;
      if (call.arguments.length !== 1 || !arg || !ts.isObjectLiteralExpression(arg) || arg.properties.length !== 1
        || !prop || !(ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop))) {
        throw new Error(`${file}: an onChange calls patchDraft with something other than one object literal of one property`);
      }
      out.push(`${file}|${propertyText(prop.name)}`);
    }
  }
  return out;
}

/**
 * Every `onChange` attribute in a parsed source that calls one of `setters` (the file's guard-fed
 * setters) directly, as `file|setter|property` for the one property its updater sets: the customer
 * page's keyed list cells, `setAddresses((cur) => cur.map((row) => (row.id === a.id ? { ...row,
 * name: v } : row)))`. Fails closed: a call whose first argument is not a function, or whose body
 * holds anything but exactly one object literal of exactly one non-spread property, is an error,
 * not a skip. The spread's receiver is not checked here: the lifted case applies the updater to
 * rows carrying a field the handler's row does not, so a spread of the render's row (`{ ...a,
 * name: v }`) fails there.
 */
function keyedCellSites(file: string, src: string, setters: Set<string>): string[] {
  const sf = parse(file, src);
  const out: string[] = [];
  for (const attr of all(sf, ts.isJsxAttribute)) {
    if (!ts.isIdentifier(attr.name) || attr.name.text !== "onChange" || !attr.initializer) continue;
    for (const call of all(attr.initializer, ts.isCallExpression)) {
      if (!ts.isIdentifier(call.expression) || !setters.has(call.expression.text)) continue;
      const setter = call.expression.text;
      const updater = call.arguments[0];
      const literals = updater && isFunctionArg(updater) ? all(updater.body, ts.isObjectLiteralExpression) : [];
      const named = literals.length === 1 ? literals[0].properties.filter((p) => !ts.isSpreadAssignment(p)) : [];
      if (named.length !== 1 || named[0].name === undefined) {
        throw new Error(`${file}: an onChange calls ${setter} with something other than an updater setting one property`);
      }
      out.push(`${file}|${setter}|${propertyText(named[0].name)}`);
    }
  }
  return out;
}

/** Every `patchDraft(…)` call under `root` whose object literal spreads something: a child section's
 *  copy of the page's detail arrives as a prop, which the render-copy rule cannot name. */
function spreadPatchDrafts(file: string, src: string): Refusal[] {
  const sf = parse(file, src);
  return all(sf, ts.isCallExpression)
    .filter((c) => ts.isIdentifier(c.expression) && c.expression.text === "patchDraft")
    .filter((c) => c.arguments[0] && ts.isObjectLiteralExpression(c.arguments[0]) && c.arguments[0].properties.some(ts.isSpreadAssignment))
    .map((c) => ({ file, line: sf.getLineAndCharacterOfPosition(c.getStart(sf)).line + 1, setter: "patchDraft", property: NO_PROPERTY,
      reason: "patchDraft is handed an object that spreads (a render copy, a prop, an older draft)" }));
}

/** Every `.ts` and `.tsx` under `src/`, repo-relative and slash-separated, sorted. */
function srcFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".ts") || rel.endsWith(".tsx"))
    .map((rel) => `src/${rel.split(sep).join("/")}`)
    .sort();
}

const readRepoFile = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

const matches = (entry: Allowed, r: Refusal) =>
  entry.file === r.file && entry.setter === r.setter && entry.property === r.property;

/**
 * The allowlist's two halves over a set of refusals: the refusals no entry names, and the entries
 * that name no refusal (stale), each keyed by file, setter and property, never by line. The real
 * walk asks it about `ALLOWED`, empty today, so the synthetic self-test below is what proves it.
 */
function allowlisted(entries: Allowed[], refusals: Refusal[]): { unallowed: Refusal[]; stale: Allowed[] } {
  return {
    unallowed: refusals.filter((r) => !entries.some((entry) => matches(entry, r))),
    stale: entries.filter((entry) => !refusals.some((r) => matches(entry, r))),
  };
}

// ---------------------------------------------------------------------------------------------
// The synthetic self-tests: the rule over shapes `src/` does not hold today, so a green walk cannot
// be the only evidence the detector sees them.
// ---------------------------------------------------------------------------------------------

describe("the detector, over in-memory sources", () => {
  const SYNTHETIC = `
    const [c, setC] = useState<Row | null>(null);
    const [rows, setRows] = useState<Row[]>([]);
    function load(res: Res) {
      setC(editGuard.applyPayload(res.row));
      setRows(editGuard.applyRows("rows", res.rows));
    }
    function patchDraft(patch: Partial<Row>) {
      setC((cur) => (cur ? { ...cur, ...patch } : cur));
    }
    const a = <input onChange={(e) => setC({ ...c, name: e.target.value })} />;
    const b = <input onChange={(e) => setC((cur) => (cur ? { ...cur, name: e.target.value } : cur))} />;
    const d = <input onChange={(e) => { const v = e.target.value; setC((cur) => ({ ...cur, ...c, name: v })); }} />;
    const s = setC;
    const f = <input onChange={(e) => setC((cur) => (cur ? { ...cur, name: e.currentTarget.value } : cur))} />;
    const g = <input onChange={({ target }) => setC((cur) => (cur ? { ...cur, name: target.value } : cur))} />;
    const h = <input onChange={(e) => setC((cur) => (cur ? { ...cur, name: e["target"].value } : cur))} />;
    const i = <input onChange={(e) => { const next = { ...c, name: e.target.value }; setC(() => next); }} />;
    const j = <input onChange={(e) => { const next = { ...c, name: e.target.value }; setC((cur) => next); }} />;
    const k = <input onChange={(e) => { const v = e.target.value; setC(({ name }) => ({ name: v })); }} />;
    const ok = <input onChange={(e) => patchDraft({ name: e.target.value })} />;
    const rowsOk = <input onChange={(e) => { const v = e.target.value; setRows((cur) => cur.map((r) => ({ ...r, v }))); }} />;
  `;

  it("refuses the object form, an event read (target, currentTarget, destructured, element access) and a render-copy read inside an updater, an alias, and an updater without or ignoring its parameter, and nothing else", () => {
    const result = sweep("src/app/x/page.tsx", SYNTHETIC);
    expect(result.census).toBe(true);
    expect(result.guardFed).toEqual([
      { setter: "setC", renderCopy: "c", via: "guard call" },
      { setter: "setRows", renderCopy: "rows", via: "guard call" },
    ]);
    expect(result.refusals.map(text)).toEqual([
      "src/app/x/page.tsx:11 setC — called with a first argument that is neither a function nor a guard call",
      `src/app/x/page.tsx:12 setC — ${EVENT_READ}`,
      "src/app/x/page.tsx:13 setC — the updater names the render copy c",
      "src/app/x/page.tsx:14 setC — referenced without being called (an alias, a prop pass or a destructure)",
      `src/app/x/page.tsx:15 setC — ${EVENT_READ}`,
      `src/app/x/page.tsx:16 setC — ${EVENT_READ}`,
      `src/app/x/page.tsx:17 setC — ${EVENT_READ}`,
      "src/app/x/page.tsx:18 setC — the updater takes no parameter (it ignores the state it is applied over)",
      "src/app/x/page.tsx:19 setC — the updater never reads its parameter cur",
      "src/app/x/page.tsx:20 setC — the updater's first parameter is not a plain identifier (destructure it in the body)",
    ]);
    // The allowlist key each would take: the property the offending read sits under, or the marker.
    expect(result.refusals.map((r) => r.property))
      .toEqual(["name", "name", NO_PROPERTY, NO_PROPERTY, "name", "name", "name", NO_PROPERTY, NO_PROPERTY, NO_PROPERTY]);
  });

  it("a bare call named applyRows is not a guard call: the file is outside the census", () => {
    const src = `
      const [rows, setRows] = useState<Row[]>([]);
      function applyRows(next: Row[]) { setRows(next); }
      const x = <button onClick={() => applyRows([])} />;
    `;
    expect(sweep("src/app/x/Section.tsx", src)).toEqual({ census: false, guardFed: [], refusals: [] });
  });

  it("a setter called with a function that calls merge is guard-fed through that function, not the callback around it", () => {
    const src = `
      const [order, setOrder] = useState<Order | null>(null);
      const load = useCallback(async (fresh: Order) => {
        const captured = editGuard.capturePayload(fresh);
        setOrder((prev) => captured.merge(prev, keep(prev, fresh)));
      }, []);
      const x = <button onClick={() => setOrder((o) => (o ? { ...o, printed: true } : o))} />;
    `;
    expect(sweep("src/app/x/page.tsx", src)).toEqual({
      census: true, guardFed: [{ setter: "setOrder", renderCopy: "order", via: "merge" }], refusals: [],
    });
  });

  it("a guard-fed setter the walk cannot pair with a useState binding fails the sweep", () => {
    const src = `
      const setC = useCallback((x: Row) => store(x), []);
      function load(res: Res) { setC(editGuard.applyPayload(res.row)); }
    `;
    expect(() => sweep("src/app/x/page.tsx", src)).toThrow("setC has no useState binding");
  });

  it("a call with no argument, a prop pass and a destructure are refusals too (fail closed)", () => {
    const src = `
      const [c, setC] = useState<Row | null>(null);
      function load(res: Res) { setC(editGuard.applyPayload(res.row)); }
      const x = <Child onChange={setC} />;
      const { setC: aliased } = { setC };
      setC();
    `;
    expect(sweep("src/app/x/page.tsx", src).refusals.map((r) => `${r.line} ${r.reason}`)).toEqual([
      "4 referenced without being called (an alias, a prop pass or a destructure)",
      "5 referenced without being called (an alias, a prop pass or a destructure)",   // the destructure's key
      "5 referenced without being called (an alias, a prop pass or a destructure)",   // and the shorthand
      "6 called with a first argument that is neither a function nor a guard call",
    ]);
  });

  it("a guard call placed where no setter is fed by it is refused", () => {
    const src = `
      const [c, setC] = useState<Row | null>(null);
      function load(res: Res) {
        const up = editGuard.applyPayload(res.row);
        setC(up);
        setC((prev) => editGuard.capturePayload(res.row).merge(prev, res.row));
      }
    `;
    expect(sweep("src/app/x/page.tsx", src).refusals.map((r) => `${r.line} ${r.setter} — ${r.reason}`)).toEqual([
      "4 editGuard.applyPayload — an applyPayload call that is not the first argument of a setter call (no setter is fed by it)",
      "6 editGuard.capturePayload — a capturePayload call that is not a const's initializer (its merge cannot be paired with a setter)",
      "5 setC — called with a first argument that is neither a function nor a guard call",
    ]);
  });

  it("a census file that feeds no setter the sweep can see fails", () => {
    const src = `
      const [c, setC] = useState<Row | null>(null);
      const apply = (p: Row) => editGuard.applyPayload(p);
      function load(res: Res) { setC(apply(res.row)); }
    `;
    expect(() => sweep("src/app/x/page.tsx", src)).toThrow("feeds no setter the sweep can see");
  });

  it("a string-literal element access is a guard call too", () => {
    const src = `
      const [c, setC] = useState<Row | null>(null);
      function load(res: Res) { setC(editGuard["applyPayload"](res.row)); }
    `;
    expect(sweep("src/app/x/page.tsx", src)).toEqual({ census: true, guardFed: [{ setter: "setC", renderCopy: "c", via: "guard call" }], refusals: [] });
  });

  it("two useState bindings declaring one setter name fail the sweep", () => {
    const src = `
      const [c, setC] = useState<Row | null>(null);
      const [d, setC] = useState<Row | null>(null);
      function load(res: Res) { setC(editGuard.applyPayload(res.row)); }
    `;
    expect(() => sweep("src/app/x/page.tsx", src)).toThrow("two useState bindings declare setC");
  });

  it("an allowlist entry names a live refusal by file, setter and property, never by line; one that names none is stale", () => {
    const { refusals } = sweep("src/app/x/page.tsx", SYNTHETIC);
    const target = { file: "src/app/x/page.tsx", setter: "setC", property: "name", reason: "r".repeat(40) };
    const fixed = { ...target, property: "street" };
    const result = allowlisted([target, fixed], refusals);
    // `target` names every refusal under `name`: line 11 (the object form) and the event reads at
    // lines 12, 15, 16 and 17; the parameter rules' refusals carry no property.
    expect(result.unallowed.map(text)).toEqual([
      "src/app/x/page.tsx:13 setC — the updater names the render copy c",
      "src/app/x/page.tsx:14 setC — referenced without being called (an alias, a prop pass or a destructure)",
      "src/app/x/page.tsx:18 setC — the updater takes no parameter (it ignores the state it is applied over)",
      "src/app/x/page.tsx:19 setC — the updater never reads its parameter cur",
      "src/app/x/page.tsx:20 setC — the updater's first parameter is not a plain identifier (destructure it in the body)",
    ]);
    expect(result.stale).toEqual([fixed]);
    expect(allowlisted([], refusals)).toEqual({ unallowed: refusals, stale: [] });
  });

  it("derives a keyed-cell onChange site by its setter and the one property its updater sets", () => {
    const src = `
      const a = <input onChange={(e) => { const v = e.target.value; setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, name: v } : r))); }} />;
      const b = <input onChange={(e) => { const v = e.target.value; setOther((cur) => cur.map((r) => ({ ...r, [key]: v }))); }} />;
      const c = <input onChange={(e) => setElse(e.target.value)} />;
      const d = <input onBlur={(e) => { const v = e.target.value; setRows((cur) => cur.map((r) => ({ ...r, ignored: v }))); }} />;
    `;
    expect(keyedCellSites("src/app/x/page.tsx", src, new Set(["setRows", "setOther"])))
      .toEqual(["src/app/x/page.tsx|setRows|name", "src/app/x/page.tsx|setOther|[key]"]);
    expect(() => keyedCellSites("src/app/x/page.tsx", src, new Set(["setElse"])))
      .toThrow("an onChange calls setElse with something other than an updater setting one property");
    expect(() => keyedCellSites("src/app/x/page.tsx", `const a = <input onChange={(e) => setRows((cur) => ({ ...cur, a: 1, b: 2 }))} />;`, new Set(["setRows"])))
      .toThrow("something other than an updater setting one property");
    // Two object literals in one updater (a conditional's both arms): not one property set.
    expect(() => keyedCellSites("src/app/x/page.tsx", `const a = <input onChange={(e) => { const v = e.target.value; setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, name: v } : { ...r }))); }} />;`, new Set(["setRows"])))
      .toThrow("something other than an updater setting one property");
  });

  it("derives a patchDraft onChange site by its one property, a computed one as [expr]", () => {
    const src = `
      const a = <input onChange={(e) => patchDraft({ poNumber: e.target.value })} />;
      const b = <textarea onChange={(e) => patchDraft({ [key]: e.target.value })} />;
      const c = <input onBlur={(e) => patchDraft({ ignored: e.target.value })} />;
      const s = <input onChange={(e) => { const notes = e.target.value; patchDraft({ notes }); }} />;
    `;
    expect(patchDraftSites("src/app/x/page.tsx", src)).toEqual(["src/app/x/page.tsx|poNumber", "src/app/x/page.tsx|[key]", "src/app/x/page.tsx|notes"]);
    expect(() => patchDraftSites("src/app/x/page.tsx", `const a = <input onChange={(e) => patchDraft({ a: 1, b: 2 })} />;`))
      .toThrow("something other than one object literal of one property");
  });

  it("a patchDraft call that spreads into its patch is refused, in any file; one that does not is not", () => {
    expect(spreadPatchDrafts("src/app/x/Section.tsx", `function f(v: string) { patchDraft({ ...part, name: v }); }`).map(text))
      .toEqual(["src/app/x/Section.tsx:1 patchDraft — patchDraft is handed an object that spreads (a render copy, a prop, an older draft)"]);
    expect(spreadPatchDrafts("src/app/x/Section.tsx", `function f(v: string) { patchDraft({ name: v }); }`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The real walk.
// ---------------------------------------------------------------------------------------------

describe("every guard-fed setter under src/ is called only with a function or a guard call", () => {
  const files = srcFiles();
  const results = new Map(files.map((file) => [file, sweep(file, readRepoFile(file))] as const));
  const census = files.filter((file) => results.get(file)!.census);
  const refusals = census.flatMap((file) => results.get(file)!.refusals);

  it("finds the census, the eight known files among it, and not the bare applyRows file", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(census.length).toBeGreaterThan(0);
    for (const known of KNOWN_CENSUS) expect(census, `${known} calls the guard`).toContain(known);
    expect(files, "the self-test's exclusion still exists").toContain(BARE_APPLY_ROWS_FILE);
    expect(census).not.toContain(BARE_APPLY_ROWS_FILE);
  });

  it("pairs every guard-fed setter with its render copy, the hub's setOrder through merge", () => {
    const fed = census.flatMap((file) => results.get(file)!.guardFed.map((g) => ({ file, ...g })));
    expect(fed.length).toBeGreaterThan(0);
    expect(fed).toContainEqual({ file: "src/app/orders/[id]/page.tsx", setter: "setOrder", renderCopy: "order", via: "merge" });
    for (const page of KNOWN_CENSUS) expect(fed.some((g) => g.file === page), `${page} has a guard-fed setter`).toBe(true);
  });

  it("raises no refusal the allowlist does not name", () => {
    expect(allowlisted(ALLOWED, refusals).unallowed.map(text)).toEqual([]);
  });

  it("keeps the allowlist honest: it is empty, and an entry would have to match a live refusal and carry a reason", () => {
    // Empty: the rule had no exception on the day it landed (the header says what its first walk
    // raised and how that was closed). A first entry needs a reason, and this assertion moves with it.
    expect(ALLOWED).toEqual([]);
    expect(allowlisted(ALLOWED, refusals).stale.map((entry) => `${entry.file} ${entry.setter} ${entry.property}: matches no refusal`))
      .toEqual([]);
    // Vacuous while ALLOWED is empty: it is the first entry's check, and `expect(ALLOWED).toEqual([])` above is what moves first.
    for (const entry of ALLOWED) {
      expect(entry.reason.length, `${entry.file} ${entry.setter} ${entry.property}: the reason is too short to be one`)
        .toBeGreaterThanOrEqual(40);
    }
  });

  it("no patchDraft call anywhere under src/ spreads into its patch", () => {
    expect(files.flatMap((f) => spreadPatchDrafts(f, readRepoFile(f))).map(text)).toEqual([]);
  });

  it("agrees with the per-site test's list: every patchDraft onChange in a census file, and no other", () => {
    const derived = census.flatMap((file) => patchDraftSites(file, readRepoFile(file))).sort();
    expect(derived).toEqual(headerSetterSiteKeys());
    expect(derived).toHaveLength(31);
  });

  it("agrees with the per-site test's keyed-cell list: every onChange in a census file that calls a guard-fed setter itself, and no other", () => {
    const derived = census.flatMap((file) =>
      keyedCellSites(file, readRepoFile(file), new Set(results.get(file)!.guardFed.map((g) => g.setter)))).sort();
    expect(derived).toEqual(keyedCellSiteKeys());
    expect(derived).toHaveLength(8);
  });
});
