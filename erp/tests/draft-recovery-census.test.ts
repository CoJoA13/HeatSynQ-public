import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { recoveryCensus } from "./helpers/draft-recovery-census";

// These are the existing registration exemptions, preserved with their reasons.
const exemptions = new Map([
  ["components/SaveButton.tsx", "shared button: registration is supplied to its consumers"],
  ["app/orders/new/page.tsx", "order draft is autosaved server-side and resumed on return"],
  ["app/board-parts/SavedViewsBar.tsx", "named filter is saved or updated immediately (R20); a board filter is not held work"],
]);
function actualProject() {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(directory, e.name)) : [join(directory, e.name)]);
  return new Map(walk(root).filter(p => /\.(ts|tsx)$/.test(p)).map(path => [path.slice(root.length + 1), readFileSync(path, "utf8")]));
}
it("derives each actual bulk hook and explicit Save consumer, including private sibling components", () => {
  const project = actualProject(); expect(project.size).toBeGreaterThan(100);
  const rows = recoveryCensus(project, exemptions); expect(rows.some(r => r.kind === "bulk")).toBe(true); expect(rows.some(r => r.kind === "save")).toBe(true);
  // No sixteen-name allowlist: every discovered call/control must carry its own evidence.
  // Task 9's object-held binding must supply the same evidence as direct binding state.
  expect(rows.filter(r => r.problems.length)).toEqual([]);
});

const options = 'export function options(source) { return { record: {kind:"shipment",id:"s"}, kind:"grid", schema:"1", read:()=>source.read(), register:f=>source.register(f) }; }';
const bulk = (name: string) => 'function ' + name + '(){ const grid=useBulkGrid(rows,toFields,options(source)); async function save(){ grid.binding.capture("body","request"); } return <SaveButton dirty={grid.dirty} onSave={save} onDiscard={()=>grid.discard()} />; }';
const direct = 'function NewShipment(){ const {store}=useBrowserDraftStore(); const [binding,setBinding]=useState(null); const view=useRecoverableDraft(binding); useEffect(()=>{setBinding(store.bind(key,metadata,adapter));},[]); const dirty=view.current?.data.dirty; async function save(){ binding.capture("body","request"); } return <button disabled={!dirty} onClick={save}>Save shipment</button>; }';
const imports = 'import {useBulkGrid} from "@/lib/bulk-grid"; import {options} from "@/lib/options"; import {useBrowserDraftStore,useRecoverableDraft} from "@/lib/use-recoverable-draft"; import {useState,useEffect} from "react";';
function fixture(source: string) { return new Map([["app/example.tsx", imports + source], ["lib/bulk-grid.ts", ""], ["lib/options.ts", options], ["lib/use-recoverable-draft.ts", ""]]); }
const problems = (project: Map<string, string>) => recoveryCensus(project).flatMap(r => r.problems.map(p => r.component + ": " + p));
it("counts each of three shipment-like sibling hooks and refuses one missing registration", () => {
  const good = fixture(bulk("Lines") + bulk("Containers") + bulk("Serials"));
  expect(problems(good)).toEqual([]); expect(recoveryCensus(good).filter(r => r.kind === "bulk").map(r => r.component)).toEqual(["Lines", "Containers", "Serials"]);
  const broken = fixture(bulk("Lines") + bulk("Containers").replace(",options(source)", "") + bulk("Serials"));
  expect(problems(broken)).toContain("Containers: missing resolved recovery options");
});
it("an import or unused binding cannot substitute for the view's actual store registration", () => {
  expect(problems(fixture(direct))).toEqual([]);
  const broken = direct.replace("setBinding(store.bind(key,metadata,adapter));", "const unused=store.bind(key,metadata,adapter);");
  expect(problems(fixture(broken))).toContain("NewShipment: Save handler is not connected to a recovery binding");
});
it("catches a future unregistered bulk hook and a raw Save beside registered components", () => {
  const future = 'function Future(){const grid=useBulkGrid(rows,toFields);return <SaveButton dirty={grid.dirty} onSave={()=>grid.save()} onDiscard={()=>grid.reset()}/>;}';
  expect(problems(fixture(direct + future))).toContain("Future: missing resolved recovery options");
  const raw = 'function FutureRaw(){const [dirty,setDirty]=useState(false);function save(){api("/write",{method:"POST"});}return <button disabled={!dirty} onClick={save}>Save</button>;}';
  expect(problems(fixture(direct + raw))).toContain("FutureRaw: Save handler is not connected to a recovery binding");
});
it("a sibling Discard does not satisfy this hook's own control", () => {
  const broken = bulk("Lines").replace("()=>grid.discard()", "()=>sibling.discard()");
  expect(problems(fixture(broken))).toContain("Lines: missing own grid Discard");
});
it("a second raw dirty gate cannot borrow an unrelated binding in the same component", () => {
  const broken = direct.replace("const dirty=view.current?.data.dirty;", "const [dirty,setDirty]=useState(false);");
  expect(problems(fixture(broken))).toContain("NewShipment: dirty gate is outside recovery: dirty");
});
it("the option factory must supply actual read/registration fields, not only a recovery-sounding name", () => {
  const project = fixture(bulk("Lines")); project.set("lib/options.ts", "export function options(){ return {}; }");
  expect(problems(project)).toContain("Lines: missing resolved recovery options");
});
it("renaming an imported hook does not remove its consumer from the census", () => {
  const project = fixture(bulk("Lines")); project.set("app/example.tsx", project.get("app/example.tsx")!.replace("{useBulkGrid}", "{useBulkGrid as gridHook}").replace("=useBulkGrid(", "=gridHook("));
  expect(recoveryCensus(project).filter(r => r.kind === "bulk")).toHaveLength(1); expect(problems(project)).toEqual([]);
});

it("follows only the property assigned to the binding consumed by the recovery hook", () => {
  const objectHeld = direct.replace("const [binding,setBinding]=useState(null);", "const [slot,setSlot]=useState(null);const binding=slot?.binding??null;")
    .replace("setBinding(store.bind(key,metadata,adapter));", "setSlot({key,binding:store.bind(key,metadata,adapter)});");
  expect(problems(fixture(objectHeld))).toEqual([]);
  expect(problems(fixture(objectHeld.replace("binding:store.bind", "other:store.bind")))).toContain("NewShipment: Save handler is not connected to a recovery binding");
  expect(problems(fixture(objectHeld.replace("slot?.binding", "slot?.other")))).toContain("NewShipment: Save handler is not connected to a recovery binding");
});

it.each(["remove assigned binding", "assign another property", "read another property"])("actual TemplateEditor property path fails closed when we %s", mutation => {
  const project = actualProject(); const file = "app/admin/templates/[id]/edit/TemplateEditor.tsx"; const source = project.get(file)!;
  expect(source, "actual TemplateEditor source").toBeDefined();
  const rows = recoveryCensus(project, exemptions).filter(r => r.file === file && r.component === "TemplateEditor");
  expect(rows.length).toBeGreaterThan(0); expect(rows.flatMap(r => r.problems)).toEqual([]);
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let assigned: ts.PropertyAssignment | undefined; let read: ts.PropertyAccessExpression | undefined;
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "setSlot") {
      const argument = node.arguments[0];
      if (argument && ts.isObjectLiteralExpression(argument)) {
        const field = argument.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === "binding"
          && ts.isCallExpression(p.initializer) && ts.isPropertyAccessExpression(p.initializer.expression) && p.initializer.expression.name.text === "bind");
        if (field && ts.isPropertyAssignment(field)) assigned = field;
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "slot" && node.name.text === "binding") read = node;
    ts.forEachChild(node, walk);
  };
  walk(parsed); expect(assigned).toBeDefined(); expect(read).toBeDefined();
  const target = mutation === "remove assigned binding" ? assigned!.initializer : mutation === "assign another property" ? assigned!.name : read!.name;
  const replacement = mutation === "remove assigned binding" ? "null" : "unrelatedBinding";
  project.set(file, source.slice(0, target.getStart(parsed)) + replacement + source.slice(target.end));
  const gaps = recoveryCensus(project, exemptions).filter(r => r.file === file && r.component === "TemplateEditor").flatMap(r => r.problems);
  expect(gaps).toContain("Save handler is not connected to a recovery binding");
});
