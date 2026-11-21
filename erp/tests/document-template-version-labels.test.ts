import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import type { EditorKey } from "../src/lib/draft-store";
function labels() {
  const source = ts.createSourceFile("DraftsInTab.tsx", readFileSync(new URL("../src/components/DraftsInTab.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && ["object", "labelFor"].includes(node.name?.text ?? ""));
  expect(declarations).toHaveLength(2);
  const code = ts.transpileModule(`${declarations.map(node => node.getText(source)).join("\n")}\nreturn labelFor;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(code)() as (key: EditorKey, response: unknown) => string | null;
}
const key = (version: string): EditorKey => ({ owner: { userId: "u", authGeneration: 1 }, record: { kind: "document-template", id: "t" }, editor: "document-template", entityVersion: version });
it("actual authorized row labels distinguish exact v1 published and v2 draft", () => {
  const label = labels(); const detail = { id: "t", name: "Owned", versions: [{ versionNumber: 1, status: "PUBLISHED" }, { versionNumber: 2, status: "DRAFT" }] };
  expect(label(key("1"), detail)).toMatch(/Owned.*version 1.*published/i);
  expect(label(key("2"), detail)).toMatch(/Owned.*version 2.*draft/i);
  expect(label(key("1"), detail)).not.toBe(label(key("2"), detail));
});
it("actual row label refuses a retained version absent from the authorized version summaries", () => {
  expect(labels()(key("1"), { id: "t", name: "Owned", versions: [{ versionNumber: 2, status: "DRAFT" }] })).toBeNull();
});
