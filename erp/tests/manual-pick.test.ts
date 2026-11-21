import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { lowerOrderNumber, pick } from "../e2e/lib/manual-pick";
import { all } from "./helpers/source-lift";

// The capture tool's choice among candidates (e2e/lib/manual-pick.ts; the weights design's §15.2).
// No test can load e2e/lib/manual-ids.ts: as it loads it refuses every database but one named erp
// on this machine, and runs its command. Its `pick` is therefore in a leaf with no import, run
// here, and what the script does with it is read from the script's source, with the TypeScript
// parser and never a pattern. Not held by any test: each choice's score and its query, which stay
// in the script. Only a run of the capture tool shows what they give: the order's choice in the
// line of its report that names the order, and each other choice on its own line.

type Candidate = { id: string; orderNumber: number; score: number };
const candidate = (orderNumber: number, score: number): Candidate => ({ id: `order-${orderNumber}`, orderNumber, score });
const score = (row: Candidate) => row.score;
const tell = (row: Candidate) => ({ label: `Order #${row.orderNumber}`, why: `${row.score} points` });
/** The label of the candidate chosen with no rule, and with the saved order's rule. */
const plain = (rows: Candidate[]) => pick(rows, score, tell)?.label;
const ruled = (rows: Candidate[]) => pick(rows, score, tell, lowerOrderNumber)?.label;

describe("pick (e2e/lib/manual-pick.ts)", () => {
  it("gives the higher score wherever it stands", () => {
    expect([
      [candidate(1014, 421), candidate(1013, 313), candidate(1004, 418)],
      [candidate(1013, 313), candidate(1014, 421), candidate(1004, 418)],
      [candidate(1013, 313), candidate(1004, 418), candidate(1014, 421)],
    ].map(plain)).toEqual(["Order #1014", "Order #1014", "Order #1014"]);
  });

  it("with no rule, gives equal scores to the earlier candidate", () => {
    expect([
      [candidate(1014, 418), candidate(1004, 418)],
      [candidate(1004, 418), candidate(1014, 418)],
    ].map(plain)).toEqual(["Order #1014", "Order #1004"]);
  });

  it("with the saved order's rule, gives equal scores to the lower order number, whichever comes first", () => {
    expect([
      // Newest first, as the script's query hands orders over, with order 1014 level with order 1004.
      [candidate(1041, 415), candidate(1014, 418), candidate(1013, 313), candidate(1004, 418)],
      [candidate(1004, 418), candidate(1014, 418)],
      [candidate(1030, 418), candidate(1014, 418), candidate(1004, 418)],
      [candidate(1004, 418), candidate(1030, 418), candidate(1014, 418)],
    ].map(ruled)).toEqual(["Order #1004", "Order #1004", "Order #1004", "Order #1004"]);
  });

  it("never lets the rule beat a higher score", () => {
    expect([
      [candidate(1014, 421), candidate(1004, 418)],
      [candidate(1004, 418), candidate(1014, 421)],
    ].map(ruled)).toEqual(["Order #1014", "Order #1014"]);
  });

  it("gives null for an empty list", () => {
    expect([pick([], score, tell), pick([], score, tell, lowerOrderNumber)]).toEqual([null, null]);
  });

  it("answers the winner's id with the label, the why and the data its describer gives", () => {
    expect(pick([candidate(7, 1)], score, (row) => ({ ...tell(row), data: { partNumber: "TD-77" } })))
      .toEqual({ id: "order-7", label: "Order #7", why: "1 points", data: { partNumber: "TD-77" } });
  });
});

describe("the capture tool's choices (e2e/lib/manual-ids.ts, read with the TypeScript parser)", () => {
  const IDS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../e2e/lib/manual-ids.ts");

  /** What the script declares by name, what it imports from the leaf, and each call of `pick`: the
   *  name the call sets, and the source text of whatever it passes after its third argument. */
  function choicesOf(source: string) {
    const file = ts.createSourceFile("manual-ids.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declared = [
      ...all(file, ts.isFunctionDeclaration).map((node) => node.name?.text),
      ...all(file, ts.isTypeAliasDeclaration).map((node) => node.name.text),
      ...all(file, ts.isVariableDeclaration).map((node) => node.name.getText(file)),
    ];
    const fromLeaf = all(file, ts.isImportDeclaration)
      .filter((node) => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./manual-pick")
      .flatMap((node) => all(node, ts.isImportSpecifier).map((specifier) => specifier.getText(file)));
    const calls = all(file, ts.isCallExpression)
      .filter((call) => ts.isIdentifier(call.expression) && call.expression.text === "pick")
      .map((call) => ({
        sets: ts.isVariableDeclaration(call.parent) ? call.parent.name.getText(file) : null,
        rule: call.arguments.length > 3 ? call.arguments.slice(3).map((argument) => argument.getText(file)).join(", ") : null,
      }));
    return { declared, fromLeaf, calls };
  }

  it("has no pick of its own, imports the leaf's two names, and gives the rule to the order's choice alone", () => {
    const { declared, fromLeaf, calls } = choicesOf(readFileSync(IDS_FILE, "utf8"));
    expect(declared.filter((name) => name === "pick" || name === "Pick")).toEqual([]);
    expect([...fromLeaf].sort()).toEqual(["lowerOrderNumber", "pick"]);
    expect(calls.filter((call) => call.rule !== null)).toEqual([{ sets: "order", rule: "lowerOrderNumber" }]);
  });
});
