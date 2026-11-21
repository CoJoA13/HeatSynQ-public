import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { INVOICE_FREEZE, invoiceFreezeSentence } from "@/lib/invoice-freeze";
import {
  LINE_NOT_FOUND, NO_UNCONFIRMED_REMOVALS, REMOVAL_NOT_CONFIRMED, alreadyRemovedMessage,
  anyRemovalUnconfirmed, removalNotice, removalProvesGone, removalReason, removalUnanswered,
  removalUnconfirmed, removalsListed, removedNotRefreshedMessage, type UnconfirmedRemovals,
} from "@/lib/line-removals";
import { resolveLocalModule } from "./helpers/ts-parse";

// The order hub's record of a line Remove the server did not answer (#475, owner ruling
// 2026-10-15, "Mark until gone"), and the one answer that proves the line gone. The leaf is pure,
// so vitest's "node" environment reaches all of it. Two source pins sit at the end: the leaf's
// imports, and the tie between the server's not-found sentence and the constant the page compares
// against. Each rule and each guard below is proven by changing it and watching the case that
// names it go red.

const marks = (...ids: string[]): UnconfirmedRemovals => new Set(ids);
const lines = (...ids: string[]) => ids.map((id) => ({ id }));

describe("the words", () => {
  it("states the server's not-found sentence and the owner's mark", () => {
    expect(LINE_NOT_FOUND).toBe("Order line not found");
    expect(REMOVAL_NOT_CONFIRMED).toBe("Removal not confirmed");
  });

  it("builds the row's reason from the line's label, in the owner's words", () => {
    expect(removalReason("Line 2")).toBe(
      "Line 2: the app could not tell whether the removal went through. Press Remove to try again, " +
      "or reload the page to see what the order holds.");
  });

  it("builds the two banners from the confirm's naming of the line", () => {
    expect(alreadyRemovedMessage("ACME · P-100 (Line 2)"))
      .toBe("ACME · P-100 (Line 2) had already been removed from this order.");
    expect(removedNotRefreshedMessage("ACME · P-100 (Line 2)", "Failed to fetch")).toBe(
      "ACME · P-100 (Line 2) is no longer on this order, but the page could not be refreshed — " +
      "reload to see the current state. (Failed to fetch)");
  });
});

describe("removalUnanswered", () => {
  it("marks the line", () => {
    expect([...removalUnanswered(NO_UNCONFIRMED_REMOVALS, "L2")]).toEqual(["L2"]);
    expect([...removalUnanswered(marks("L2"), "L3")].sort()).toEqual(["L2", "L3"]);
  });

  it("returns the same Set when the line is already marked", () => {
    const cur = marks("L2");
    expect(removalUnanswered(cur, "L2")).toBe(cur);
  });

  it("never writes into the Set it was given", () => {
    removalUnanswered(NO_UNCONFIRMED_REMOVALS, "L2");
    expect(NO_UNCONFIRMED_REMOVALS.size).toBe(0);
    const cur = marks("L2");
    removalUnanswered(cur, "L3");
    expect([...cur]).toEqual(["L2"]);
  });
});

describe("removalsListed", () => {
  it("keeps the mark of a line the payload still lists, and the same Set (R18)", () => {
    // A payload that lists the line may predate the lost DELETE's commit. It ends nothing.
    const cur = marks("L2");
    expect(removalsListed(cur, ["L1", "L2"])).toBe(cur);
    expect(removalsListed(cur, new Set(["L2", "L1"]))).toBe(cur);
  });

  it("drops the mark of a line the payload no longer lists", () => {
    expect([...removalsListed(marks("L2", "L3"), ["L1", "L3"])]).toEqual(["L3"]);
    expect(removalsListed(marks("L2"), ["L1"]).size).toBe(0);
  });

  it("returns the same Set when nothing drops, and never writes into it", () => {
    expect(removalsListed(NO_UNCONFIRMED_REMOVALS, ["L1"])).toBe(NO_UNCONFIRMED_REMOVALS);
    expect(removalsListed(NO_UNCONFIRMED_REMOVALS, [])).toBe(NO_UNCONFIRMED_REMOVALS);
    const cur = marks("L2", "L3");
    removalsListed(cur, ["L3"]);
    expect([...cur]).toEqual(["L2", "L3"]);
  });
});

describe("anyRemovalUnconfirmed", () => {
  it("is false with no marks", () => {
    expect(anyRemovalUnconfirmed(NO_UNCONFIRMED_REMOVALS, lines("L1", "L2"))).toBe(false);
  });

  it("is true for a mark on a line the order on the page lists", () => {
    expect(anyRemovalUnconfirmed(marks("L2"), lines("L1", "L2"))).toBe(true);
  });

  it("is false for a mark on a line the order on the page no longer lists", () => {
    // A failure that landed after a payload had already dropped the line: the next payload prunes
    // it, and until then it is counted by nothing (`anyNotSaved`'s server filter).
    expect(anyRemovalUnconfirmed(marks("L2"), lines("L1"))).toBe(false);
    expect(anyRemovalUnconfirmed(marks("L2", "L3"), lines("L1", "L3"))).toBe(true);
  });
});

describe("removalUnconfirmed and removalNotice", () => {
  it("answers for a marked line, with the reason that names it", () => {
    expect(removalUnconfirmed(marks("L2"), "L2")).toBe(true);
    expect(removalNotice(marks("L2"), "L2", "Line 2")).toBe(removalReason("Line 2"));
  });

  it("answers nothing for a line that is not marked", () => {
    expect(removalUnconfirmed(marks("L2"), "L3")).toBe(false);
    expect(removalUnconfirmed(NO_UNCONFIRMED_REMOVALS, "L2")).toBe(false);
    expect(removalNotice(marks("L2"), "L3", "Line 3")).toBeNull();
    expect(removalNotice(NO_UNCONFIRMED_REMOVALS, "L2", "Line 2")).toBeNull();
  });
});

describe("removalProvesGone", () => {
  const changeLine = invoiceFreezeSentence(INVOICE_FREEZE.changeLine, { invoiceId: "inv-1", orderNumber: 1031 });
  const conflict = "Another change to that order was saved at the same time — please try again";

  it("is true only for the app's 404, word for word, a first Remove as well as a retry", () => {
    expect(removalProvesGone(404, LINE_NOT_FOUND)).toBe(true);
    expect(removalProvesGone(404, "Order line not found")).toBe(true);
  });

  it.each([
    ["a missing or voided order, or a P2025 withDbErrors maps", 404, "Order not found"],
    ["a 404 that is not the app's (api()'s fallback text)", 404, "Request failed (404)"],
    ["another sentence that only starts like it", 404, "Order line not found."],
    ["the sentence under another status", 400, LINE_NOT_FOUND],
    ["a refusal under a finalized invoice, read before the line (#486)", 400, changeLine],
    ["the lead refusal", 400, "The lead part cannot be removed — void the order instead"],
    ["a serialization conflict", 409, conflict],
    ["no answer", null, "Failed to fetch"],
    ["no answer, carrying the sentence", null, LINE_NOT_FOUND],
    ["a 5xx", 500, LINE_NOT_FOUND],
  ] as const)("is false for %s", (_why, status, message) => {
    expect(removalProvesGone(status, message)).toBe(false);
  });
});

describe("scenario: a mark ends only when a payload no longer lists the line", () => {
  it("survives a payload that lists the line and an answered retry, and goes with the line", () => {
    const order = ["L1", "L2"];
    let cur: UnconfirmedRemovals = NO_UNCONFIRMED_REMOVALS;
    // The DELETE of L2 got no answer.
    cur = removalUnanswered(cur, "L2");
    expect(anyRemovalUnconfirmed(cur, lines(...order))).toBe(true);
    // Another section's save answers with the order, which still lists L2.
    cur = removalsListed(cur, order);
    expect(removalNotice(cur, "L2", "Line 2")).toBe(removalReason("Line 2"));
    // The retry is refused (an answered 409), which does not prove the line gone. The leaf has no
    // transition for a refusal; that the section applies none, so the mark stays, is pinned in
    // lines-section-wiring.test.ts.
    expect(removalProvesGone(409, "Another change to that order was saved at the same time — please try again"))
      .toBe(false);
    // The next retry answers 404 LINE_NOT_FOUND, and the order read after it no longer lists L2.
    expect(removalProvesGone(404, LINE_NOT_FOUND)).toBe(true);
    cur = removalsListed(cur, ["L1"]);
    expect(cur.size).toBe(0);
    expect(anyRemovalUnconfirmed(cur, lines("L1"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Source pins: parsed, never pattern-matched (#188).
// ---------------------------------------------------------------------------------------------

const ROOT = process.cwd();
const LEAF = "src/lib/line-removals.ts";

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function all<T extends ts.Node>(node: ts.Node, is: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node): void => {
    if (is(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** Every source file under src/, root-relative with forward slashes. */
function sources(dir = join(ROOT, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [relative(ROOT, path).split(sep).join("/")] : [];
  });
}

describe("the leaf's imports", () => {
  it("brings in line-field-saves at run time and nothing else, and nothing from src/server", () => {
    const file = parse(LEAF);
    const runtime: string[] = [];
    for (const stmt of file.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const clause = stmt.importClause;
        const typeOnly = clause !== undefined && (clause.isTypeOnly || (
          clause.name === undefined && clause.namedBindings !== undefined
          && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.every((el) => el.isTypeOnly)));
        expect(resolveLocalModule(ROOT, LEAF, stmt.moduleSpecifier.text) ?? "").not.toMatch(/^src\/server\//);
        if (!typeOnly) runtime.push(stmt.moduleSpecifier.text);
      }
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        runtime.push(stmt.moduleSpecifier.text);
      }
    }
    expect(runtime).toEqual(["./line-field-saves"]);
    // `require(…)` and a dynamic `import(…)` are the other ways in.
    const calls = all(file, ts.isCallExpression);
    expect(calls.filter((c) => c.expression.kind === ts.SyntaxKind.ImportKeyword)).toEqual([]);
    expect(calls.filter((c) => ts.isIdentifier(c.expression) && c.expression.text === "require")).toEqual([]);
  });
});

describe("the server's not-found sentence is the leaf's constant", () => {
  // The page tells "gone" from "unknown" by comparing the server's sentence with LINE_NOT_FOUND. A
  // server that retyped it would keep working until someone changed one copy, and then every
  // removal answered 404 would read as proving nothing, silently. The literal pins in
  // orders.test.ts keep the wire text itself honest.
  const ORDER_EDIT = "src/server/order-edit.ts";

  it("is imported by order-edit.ts from the leaf, whichever way the specifier is spelled", () => {
    const file = parse(ORDER_EDIT);
    const fromLeaf = file.statements.filter(ts.isImportDeclaration).filter((stmt) =>
      ts.isStringLiteral(stmt.moduleSpecifier)
      && resolveLocalModule(ROOT, ORDER_EDIT, stmt.moduleSpecifier.text) === LEAF);
    const names = fromLeaf.flatMap((stmt) => {
      const bindings = stmt.importClause?.namedBindings;
      if (stmt.importClause?.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) return [];
      return bindings.elements.filter((el) => !el.isTypeOnly).map((el) => el.name.text);
    });
    expect(names).toContain("LINE_NOT_FOUND");
  });

  it("is what removeLine throws for a line its order does not hold", () => {
    const file = parse(ORDER_EDIT);
    const removeLine = file.statements.find((s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) && s.name?.text === "removeLine");
    expect(removeLine).toBeDefined();
    const throws = all(removeLine!, ts.isNewExpression)
      .filter((n) => n.expression.getText(file) === "HttpError")
      .map((n) => (n.arguments ?? []).map((a) => a.getText(file)).join(", "));
    expect(throws.filter((t) => t === "404, LINE_NOT_FOUND")).toHaveLength(1);
  });

  it("is written out nowhere under src/ but in the leaf", () => {
    const files = sources();
    expect(files).toContain(LEAF);
    expect(files).toContain(ORDER_EDIT);
    const found: string[] = [];
    for (const path of files) {
      if (path === LEAF) continue;
      const file = parse(path);
      const visit = (n: ts.Node): void => {
        const literal = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
          || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
        const text = literal ? (n as ts.LiteralLikeNode).text : ts.isJsxText(n) ? n.text : "";
        if (text.includes(LINE_NOT_FOUND)) found.push(`${path}:${file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1}`);
        ts.forEachChild(n, visit);
      };
      visit(file);
    }
    expect(found).toEqual([]);
  });
});
