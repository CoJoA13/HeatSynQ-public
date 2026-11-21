// P7 step 7 (2026-10-22 review): every reason dialog asks through one leaf, and each caller keeps
// the shape around it — its cancelled return and its blank refusal — in its own words and slot.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { reasonPromptText } from "@/lib/reason-prompt";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

/** None since PR 12 (#827): roles' delete, which asked "Why?" in the audit trail's words, asks through the modal. */
const EXEMPT = new Set<string>();

// `kind` is the native `prompt(reasonPromptText(…))` or the modal's `askReason({ question, verb, blankRefusal })`
// (src/lib/modal.ts, ruling 5 of 2026-10-30). A modal site passes its blank refusal to the leaf, which
// holds the dialog open and shows it, so `blankRefusal` is that argument's presence there; the
// cancelled `null` return is the caller's in both forms.
type Site = { file: string; line: number; kind: "prompt" | "askReason"; leaf: boolean; verb: string | null; nullReturn: boolean; blankRefusal: boolean };

function sites(): Site[] {
  return walk(SRC).filter((f) => /\.tsx?$/.test(f)).flatMap((file) => parseSites(readFileSync(file, "utf8"), file));
}

function parseSites(source: string, file: string): Site[] {
  {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: Site[] = [];
    const isPrompt = (e: ts.Expression) => (ts.isIdentifier(e) && e.text === "prompt")
      || (ts.isPropertyAccessExpression(e) && e.name.text === "prompt"
        && ts.isIdentifier(e.expression) && ["window", "globalThis", "self"].includes(e.expression.text));
    const isAskReason = (e: ts.Expression) => ts.isIdentifier(e) && e.text === "askReason";
    const enclosing = (node: ts.Node): string => {
      let fn: ts.Node | undefined = node.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      return fn ? fn.getText(sf) : "";
    };
    const where = (node: ts.Node) => ({
      file: file.startsWith(SRC) ? relative(SRC, file).split(sep).join("/") : file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    });
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isPrompt(node.expression)) {
        const arg = node.arguments[0];
        const leaf = arg !== undefined && ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)
          && arg.expression.text === "reasonPromptText";
        const verbArg = leaf ? (arg as ts.CallExpression).arguments[1] : undefined;
        const body = enclosing(node);
        out.push({
          ...where(node), kind: "prompt", leaf,
          verb: verbArg && ts.isStringLiteral(verbArg) ? verbArg.text : null,
          // Reverse also cancels its departure attempt on that branch (#568/#581), so a block counts.
          nullReturn: /if \(reason === null\) (?:return;|\{[^}]*\breturn; \})/.test(body),
          blankRefusal: /if \(!reason\.trim\(\)\)/.test(body),
        });
      } else if (ts.isCallExpression(node) && isAskReason(node.expression)) {
        const arg = node.arguments[0];
        const props = arg !== undefined && ts.isObjectLiteralExpression(arg) ? arg.properties : [];
        const prop = (name: string) => props.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) as ts.PropertyAssignment | undefined;
        const verbArg = prop("verb")?.initializer;
        const body = enclosing(node);
        out.push({
          ...where(node), kind: "askReason",
          // The modal form IS the leaf: askReason builds its words from reasonPromptText.
          leaf: prop("question") !== undefined,
          verb: verbArg && ts.isStringLiteral(verbArg) ? verbArg.text : null,
          nullReturn: /if \(reason === null\) (?:return;|\{[^}]*\breturn; \})/.test(body),
          blankRefusal: prop("blankRefusal") !== undefined,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  }
}

describe("reasonPromptText", () => {
  it("is the question, a blank line, then the line the flows read", () => {
    expect(reasonPromptText("Void order #1001?", "voiding"))
      .toBe("Void order #1001?\n\nReason for voiding (recorded in the audit history):");
  });
});

describe("every reason dialog asks through the leaf (P7 step 7)", () => {
  const all = sites();
  const asked = all.filter((s) => !EXEMPT.has(s.file));

  it("finds the dialogs, in either form", () => {
    // The floor counts both forms, so the census holds while sites convert one page at a time.
    // 19 until PR 3 of the UX redesign took the quotes list's row Close with its dialog (the
    // quote page keeps its own three, owner 2026-10-31).
    expect(asked.length).toBeGreaterThanOrEqual(18);
  });

  it("sees the modal form (a fixture through the same parser)", () => {
    // `sites()` walks src/; this proves the askReason branch on a literal, so the census cannot
    // go vacuous before the first page converts.
    const fixture = `async function f() { const reason = await askReason({ question: "Void?", verb: "voiding", blankRefusal: "A reason is required." }); if (reason === null) return; }`;
    expect(parseSites(fixture, "fixture.tsx")).toEqual([
      { file: "fixture.tsx", line: 1, kind: "askReason", leaf: true, verb: "voiding", nullReturn: true, blankRefusal: true },
    ]);
  });

  it("refuses a prompt that builds its own text", () => {
    expect(asked.filter((s) => !s.leaf).map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  it("names the action with a literal -ing verb", () => {
    expect(asked.filter((s) => !s.verb || !/^[a-z]+ing$/.test(s.verb)).map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  it("keeps each caller's cancelled return and blank refusal", () => {
    expect(asked.filter((s) => !s.nullReturn || !s.blankRefusal).map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  it("holds no exemption", () => {
    expect(all.filter((s) => s.file === "app/admin/roles/page.tsx").map((s) => [s.kind, s.verb])).toEqual([["askReason", "deleting"]]);
  });
});
