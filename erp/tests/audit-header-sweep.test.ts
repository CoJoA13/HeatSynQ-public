// The header-only snapshot (`auditedUpdate(..., { snapshot: "header" })`, owner ruling R5 of the
// 2026-10-22 review; #617, #616) records no child row, and the lines-only snapshot (`snapshot:
// "lines"`, owner ruling 2026-11-02 on #616) records the order's lines and no other child. Each is
// sound only while the call cannot write what it leaves out: a child written inside such a `doIt`
// would leave no trace in history. So this sweep proves each narrowed call site, parsed and failing
// CLOSED. A header-mode site: the model is one `SNAPSHOT_HEADER` lists, and `doIt` is exactly one
// `<client>.<model>.update({ where, data })`. A lines-mode site: the model is one `SNAPSHOT_LINES`
// lists, and `doIt` is exactly one update of that model's line table (`orderLine`) whose `where`
// names one row by `id`. Either way `data`, inline or the object literal a `const` binds in the
// nearest enclosing scope that declares it, holds no nested-write key at any depth, through every
// spread it reaches (a conditional spread's two branches, a spread of another local object
// literal). A shape the walk cannot resolve is refused, never skipped. The set of sites is pinned
// too, so a new narrowed caller is a decision rather than a default.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { SNAPSHOT_HEADER, SNAPSHOT_LINES } from "@/server/audit";

const ROOT = join(process.cwd(), "src", "server");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out.sort();
}

/** Prisma's nested-write keys: any one of them under `data` writes or links a related row. */
const NESTED_WRITE = new Set([
  "create", "createMany", "connect", "connectOrCreate", "upsert", "update", "updateMany",
  "delete", "deleteMany", "set", "disconnect",
]);

type Site = { file: string; line: number; model: string; mode: "header" | "lines" };

/** The table a lines-mode `doIt` may update, per `SNAPSHOT_LINES` model. */
const LINE_TABLE: Record<string, string> = { order: "orderLine" };

function propName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

/** The object literal a `const <name>` binds in the nearest scope enclosing `from` that declares
 *  the name (a block, a function body or the file), or null. Scope by scope, never file-wide: one
 *  file can hold two functions that each declare their own `patch`, and the first one in the file
 *  is not necessarily the one the call reads. */
function localObjectLiteral(from: ts.Node, name: string): ts.ObjectLiteralExpression | null {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    const statements = ts.isBlock(scope) || ts.isSourceFile(scope) ? scope.statements : null;
    if (!statements) continue;
    for (const st of statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const decl of st.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue;
        const init = decl.initializer ? unwrap(decl.initializer) : undefined;
        return init && ts.isObjectLiteralExpression(init) ? init : null;
      }
    }
  }
  return null;
}

/** Walks a `data` object literal; returns the refusals it finds (empty means clean). */
function dataRefusals(obj: ts.ObjectLiteralExpression, path: string, seen: Set<string>): string[] {
  const out: string[] = [];
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      const key = propName(prop.name);
      if (key === null) { out.push(`${path}: a computed property name cannot be judged`); continue; }
      if (NESTED_WRITE.has(key)) { out.push(`${path}.${key}: a nested-write key`); continue; }
      if (ts.isPropertyAssignment(prop)) {
        const value = unwrap(prop.initializer);
        if (ts.isObjectLiteralExpression(value)) out.push(`${path}.${key}: an object value is a relation write shape, not a scalar`);
      }
    } else if (ts.isSpreadAssignment(prop)) {
      const expr = unwrap(prop.expression);
      if (ts.isConditionalExpression(expr)) {
        for (const branch of [unwrap(expr.whenTrue), unwrap(expr.whenFalse)]) {
          if (ts.isObjectLiteralExpression(branch)) out.push(...dataRefusals(branch, `${path}.{spread}`, seen));
          else out.push(`${path}: a conditional spread branch that is not an object literal cannot be judged`);
        }
      } else if (ts.isIdentifier(expr)) {
        if (seen.has(expr.text)) { out.push(`${path}: spread of ${expr.text} resolves in a cycle`); continue; }
        const resolved = localObjectLiteral(obj, expr.text);
        if (resolved === null) out.push(`${path}: spread of ${expr.text}, which no const object literal in this file binds`);
        else out.push(...dataRefusals(resolved, `${path}.{...${expr.text}}`, new Set([...seen, expr.text])));
      } else if (ts.isObjectLiteralExpression(expr)) {
        out.push(...dataRefusals(expr, `${path}.{spread}`, seen));
      } else {
        out.push(`${path}: a spread of ${ts.SyntaxKind[expr.kind]} cannot be judged`);
      }
    } else {
      out.push(`${path}: ${ts.SyntaxKind[prop.kind]} cannot be judged`);
    }
  }
  return out;
}

/** The one call a header-mode `doIt` is allowed to make, or the refusal. */
function doItCall(doIt: ts.Expression): ts.CallExpression | string {
  const fn = unwrap(doIt);
  if (!ts.isArrowFunction(fn)) return "doIt is not an arrow function";
  const body = fn.body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return "doIt's block has more than one statement";
    const [only] = body.statements;
    const expr = ts.isReturnStatement(only) ? only.expression : ts.isExpressionStatement(only) ? only.expression : undefined;
    if (!expr) return "doIt's one statement is neither a return nor an expression";
    const call = unwrap(expr);
    return ts.isCallExpression(call) ? call : "doIt's statement is not a call";
  }
  const call = unwrap(body);
  return ts.isCallExpression(call) ? call : "doIt's body is not a call";
}

/** The refusals for a narrowed `doIt`'s one call: `<client>.<target>.update({ where, data })`, its
 *  data free of nested writes and, in lines mode, its `where` exactly `{ id }` (one row). */
function updateRefusals(call: ts.CallExpression, target: string | null, mode: "header" | "lines", where: string): string[] {
  const out: string[] = [];
  const callee = call.expression;
  const isUpdate = ts.isPropertyAccessExpression(callee) && callee.name.text === "update"
    && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === target
    && ts.isIdentifier(callee.expression.expression);
  if (!isUpdate) out.push(`${where}: doIt is not <client>.${target}.update(...)`);
  const arg = call.arguments.length === 1 ? unwrap(call.arguments[0]) : undefined;
  if (!arg || !ts.isObjectLiteralExpression(arg)) return [...out, `${where}: update takes one object literal`];
  const keys = arg.properties.map((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? propName(p.name) : null));
  if (keys.some((k) => k === null) || keys.sort().join(",") !== "data,where") out.push(`${where}: update's argument is not exactly { where, data }`);
  const named = (key: string) => arg.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && propName(p.name) === key);
  const resolve = (prop: ts.ObjectLiteralElementLike | undefined, key: string): ts.ObjectLiteralExpression | null => {
    if (prop && ts.isShorthandPropertyAssignment(prop)) return localObjectLiteral(call, key);
    if (prop && ts.isPropertyAssignment(prop)) {
      const init = unwrap(prop.initializer);
      if (ts.isObjectLiteralExpression(init)) return init;
      if (ts.isIdentifier(init)) return localObjectLiteral(call, init.text);
    }
    return null;
  };
  if (mode === "lines") {
    const whereObj = resolve(named("where"), "where");
    const whereKeys = whereObj?.properties.map((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? propName(p.name) : null));
    if (!whereKeys || whereKeys.length !== 1 || whereKeys[0] !== "id") out.push(`${where}: a lines-mode update's where is not exactly { id }`);
  }
  const dataObj = resolve(named("data"), "data");
  if (dataObj === null) out.push(`${where}: data is neither an object literal nor a local const object literal`);
  else out.push(...dataRefusals(dataObj, `${where} data`, new Set()));
  return out;
}

/** One source file's narrowed call sites and the refusals they draw. */
function judgeSource(text: string, rel: string): { sites: Site[]; refusals: string[] } {
  const sites: Site[] = [];
  const refusals: string[] = [];
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "auditedUpdate") {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const where = `${rel}:${line}`;
      const opts = node.arguments[3] ? unwrap(node.arguments[3]) : undefined;
      if (opts && ts.isObjectLiteralExpression(opts)) {
        const snapshotProp = opts.properties.find((p) => ts.isPropertyAssignment(p) && propName(p.name) === "snapshot");
        if (snapshotProp && ts.isPropertyAssignment(snapshotProp)) {
          const value = unwrap(snapshotProp.initializer);
          if (!ts.isStringLiteral(value) || !["header", "lines", "full"].includes(value.text)) {
            refusals.push(`${where}: snapshot is not the literal "header", "lines" or "full"`);
          } else if (value.text === "header" || value.text === "lines") {
            const mode = value.text;
            const modelArg = node.arguments[0] ? unwrap(node.arguments[0]) : undefined;
            const model = modelArg && ts.isStringLiteral(modelArg) ? modelArg.text : null;
            const map = mode === "header" ? SNAPSHOT_HEADER : SNAPSHOT_LINES;
            if (model === null) refusals.push(`${where}: the model is not a string literal`);
            else if (!Object.hasOwn(map, model)) refusals.push(`${where}: ${model} has no ${mode === "header" ? "SNAPSHOT_HEADER" : "SNAPSHOT_LINES"} entry`);
            const target = model === null ? null : mode === "header" ? model : (LINE_TABLE[model] ?? null);
            if (model !== null && target === null) refusals.push(`${where}: ${model} names no line table`);
            const call = node.arguments[2] ? doItCall(node.arguments[2]) : "no doIt";
            if (typeof call === "string") refusals.push(`${where}: ${call}`);
            else refusals.push(...updateRefusals(call, target, mode, where));
            if (model !== null) sites.push({ file: rel, line, model, mode });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { sites, refusals };
}

function sweep(): { sites: Site[]; refusals: string[] } {
  const sites: Site[] = [];
  const refusals: string[] = [];
  for (const file of tsFiles(ROOT)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("auditedUpdate")) continue;
    const judged = judgeSource(text, relative(process.cwd(), file));
    sites.push(...judged.sites);
    refusals.push(...judged.refusals);
  }
  return { sites, refusals };
}

describe("narrowed audit snapshots are asked for by the patches that cannot reach what they omit (R5, #617, #616)", () => {
  const { sites, refusals } = sweep();

  it("every narrowed call site is one scalar update (a header model's own, or one line of a lines model), with no nested write reachable from its data", () => {
    expect(refusals).toEqual([]);
  });

  // The three header mutators (R5), the order line edit (#616), and R26's header-only writes (#711
  // step 5): the order status flips (recompute, a reversal's REOPENED, finalize's INVOICED), Link
  // and Unlink's `linkGroupId`, and a cert's first-print `printedAt`. Invoice finalize and unlock
  // keep the full snapshot (ruling 26).
  it("the narrowed call sites are the header mutators, the order line edit and R26's header-only writes, and no other", () => {
    expect(sites.map((s) => `${s.file} ${s.model} ${s.mode}`).sort()).toEqual([
      "src/server/certs.ts cert header",
      "src/server/certs.ts cert header",
      "src/server/invoices.ts invoice header",
      "src/server/invoices.ts order header",
      "src/server/order-edit.ts order header",
      "src/server/order-edit.ts order header",
      "src/server/order-edit.ts order header",
      "src/server/order-edit.ts order header",
      "src/server/order-edit.ts order lines",
      "src/server/ship-ledger.ts order header",
      "src/server/shippers.ts order header",
    ]);
  });

  // The walk itself: a nested write under a spread of a local const, and a relation object value,
  // are both caught; a clean conditional spread is not. Proved on synthetic sources so a green run
  // on the real tree cannot be a walk that sees nothing.
  it("the data walk refuses a nested write reached through a local spread and an object-valued property, and passes conditional scalar spreads", () => {
    const judge = (body: string) => {
      const source = ts.createSourceFile("x.ts", body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      let obj: ts.ObjectLiteralExpression | null = null;
      const visit = (n: ts.Node) => {
        if (!obj && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "patch" && n.initializer && ts.isObjectLiteralExpression(unwrap(n.initializer))) obj = unwrap(n.initializer) as ts.ObjectLiteralExpression;
        ts.forEachChild(n, visit);
      };
      visit(source);
      expect(obj).not.toBeNull();
      return dataRefusals(obj!, "patch", new Set());
    };
    expect(judge(`const patch = { ...(a ? { poNumber: p } : {}), notes: n };`)).toEqual([]);
    expect(judge(`const extra = { lines: { deleteMany: {} } }; const patch = { ...extra, notes: n };`)).not.toEqual([]);
    expect(judge(`const patch = { customer: { connect: { id } } };`)).not.toEqual([]);
    expect(judge(`const patch = { ...other };`)).not.toEqual([]);
  });

  // The call-site judge on synthetic files: a lines-mode site is held to one `orderLine` row, and a
  // `data` const resolves in the call's own scope. order-edit.ts holds two functions that each
  // declare `patch`; a file-wide lookup takes the first and judges the wrong object.
  it("a lines-mode site is refused unless it updates one orderLine by id, and data resolves in the call's own scope", () => {
    const refusalsOf = (body: string) => judgeSource(body, "x.ts").refusals;
    const header = `async function h(tx, id) { const patch = { notes: n }; await auditedUpdate("order", id, () => tx.order.update({ where: { id }, data: patch }), { tx, snapshot: "header" }); }`;
    const lines = (where: string, data: string, table = "orderLine") =>
      `async function l(tx, orderId, lineId) { const patch = ${data}; await auditedUpdate("order", orderId, () => tx.${table}.update({ where: ${where}, data: patch }), { tx, snapshot: "lines" }); }`;
    expect(refusalsOf(header + lines("{ id: lineId }", "{ qty: q }"))).toEqual([]);
    expect(refusalsOf(header + lines("{ id: lineId }", "{ serials: { deleteMany: {} } }"))).not.toEqual([]);
    expect(refusalsOf(header + lines("{ orderId }", "{ qty: q }"))).not.toEqual([]);
    expect(refusalsOf(header + lines("{ id: lineId }", "{ qty: q }", "order"))).not.toEqual([]);
    expect(refusalsOf(lines("{ id: lineId }", "{ qty: q }").replace(`"order", orderId`, `"invoice", orderId`))).not.toEqual([]);
  });
});
