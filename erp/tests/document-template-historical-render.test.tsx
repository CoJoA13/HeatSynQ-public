import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import { CERT_DEFAULT_CONFIG, contractFor } from "../src/lib/template-contracts";
import { DraftRecoveryNotice } from "../src/components/DraftRecoveryNotice";
import { documentTemplateRecoveryAdapter, documentTemplateDraftFrom, readDocumentTemplate, readRetainedDocumentTemplate,
  type DocumentTemplateBaseline } from "../src/lib/document-template-recovery";

const ast = ts.createSourceFile("TemplateEditor.tsx", readFileSync(new URL("../src/app/admin/templates/[id]/edit/TemplateEditor.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === "TemplateEditor") as ts.FunctionDeclaration;
function variable(name: string) {
  const node = component.body!.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(ast) === name));
  expect(node, `actual component variable ${name}`).toBeDefined(); return node as ts.VariableStatement;
}
function compile(code: string, environment: Record<string, unknown>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(environment), js)(...Object.values(environment));
}
function fixture() {
  const permissions = ["templates.view", "templates.edit"]; const store = createDraftStore(); const session = createDraftSession(store);
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const key = { owner, record: { kind: "document-template", id: "t" }, editor: documentTemplateRecoveryAdapter.kind, entityVersion: "1" };
  const binding = store.bind(key, { label: "Template", href: "/admin/templates/t/edit" }, documentTemplateRecoveryAdapter); binding.attach("historical");
  const baseline: DocumentTemplateBaseline = { source: "open", status: "DRAFT", templateId: "t", docType: "CERT", versionNumber: 1,
    config: structuredClone(CERT_DEFAULT_CONFIG), updatedAt: "2026-09-12T00:00:00.000Z", logoMimeType: null, permissions };
  binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline, editable: true }, documentTemplateDraftFrom(baseline));
  binding.change(d => ({ ...d, dirty: true, config: { ...d.config, textBlocks: { cert_statement: "Protected raw statement" } } }));
  const historical: DocumentTemplateBaseline = { source: "historical", status: "PUBLISHED", templateId: "t", docType: "CERT", versionNumber: 1,
    config: baseline.config, updatedAt: baseline.updatedAt, hasLogo: false, permissions };
  binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline: historical, editable: false, recoveryAllowed: false }, () => documentTemplateDraftFrom(baseline));
  const detail = { id: "t", docType: "CERT", name: "Protected customer template", draft: { versionNumber: 2, config: baseline.config, updatedAt: baseline.updatedAt, logoMimeType: null },
    versions: [{ versionNumber: 1, status: "PUBLISHED" }, { versionNumber: 2, status: "DRAFT" }] };
  let discovery: { detail: typeof detail; revision: number } | null = { detail, revision: 0 }; let error: string | null = null;
  const token = { live: true, binding }; const active = { current: token };
  const api = vi.fn(async (path: string) => {
    if (path === "/api/templates/t") return detail;
    if (path === "/api/templates/t/versions/1") return { versionNumber: 1, status: "PUBLISHED", config: baseline.config, updatedAt: baseline.updatedAt, hasLogo: false };
    if (path === "/api/auth/me") return { id: "u1", permissions: [] };
    throw new Error(`Unexpected request ${path}`);
  });
  const environment = () => ({ React, DraftRecoveryNotice, documentTemplateRecoveryAdapter, documentTemplateDraftFrom,
    Link: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
    summary: store.getSnapshot(), discovery, revision: 0, view: binding.getSnapshot(), historical: true, contract: contractFor("CERT"),
    slot: { key, binding }, binding, requested: key, openVersion: 2, saving: false, readId: 0, error, active, templateId: "t", store,
    setRequested: vi.fn(), setRetry: vi.fn(), discardCopy: vi.fn(), loadRecovery: vi.fn(), setReadId: vi.fn(),
    setDiscovery: (next: typeof discovery) => { discovery = next; }, setError: (next: string | null) => { error = next; },
    getBrowserDraftSession: () => session, readDocumentTemplate, readRetainedDocumentTemplate, api,
    sameKey: (a: typeof key, b: typeof key) => a === b,
  });
  function render() {
    // The actual detail projection, preview/notice construction and historical
    // return branches run unchanged; hooks, unrelated panels and effects are excluded.
    const guards = component.body!.statements.filter(s => ts.isIfStatement(s) && (s.expression.getText(ast).includes("!detail") || s.expression.getText(ast) === "historical"));
    expect(guards).toHaveLength(3); // includes the later no-open-draft guard; use the first two only.
    const code = [variable("detail"), variable("preview"), variable("notice"), ...guards.slice(0, 2)].map(n => n.getText(ast)).join("\n");
    return renderToStaticMarkup(compile(`${code}\nreturn null;`, environment()));
  }
  async function refresh() {
    const declaration = variable("loadRecovery").declarationList.declarations[0];
    const call = declaration.initializer as ts.CallExpression;
    const callback = compile(`return (${call.arguments[0].getText(ast)});`, environment()) as () => Promise<void>;
    await callback();
  }
  return { binding, store, api, render, refresh };
}
describe("actual historical component presentation boundary", () => {
  it("fresh denied historical read hides cached protected name and raw preview but keeps generic retry destination", async () => {
    const h = fixture(); expect(h.render()).toContain("Protected customer template"); expect(h.render()).toContain("Protected raw statement");
    await h.refresh(); expect(h.api).toHaveBeenCalledWith("/api/templates/t"); expect(h.api).toHaveBeenCalledWith("/api/auth/me");
    expect(h.binding.getSnapshot().mode).toBe("unavailable");
    const html = h.render(); expect(html).not.toContain("Protected customer template"); expect(html).not.toContain("Protected raw statement");
    expect(html).toContain("Retained changes"); expect(html).toContain("Check access and saved record again");
    expect(h.store.getSnapshot().count).toBe(1);
  });
  it("render projects core-validated human preview without rerunning adapter validation", () => {
    const h = fixture(); const valid = vi.spyOn(documentTemplateRecoveryAdapter, "valid");
    try {
      const html = h.render(); expect(html).toContain("Protected raw statement"); expect(html).toContain("Font family");
      expect(valid).not.toHaveBeenCalled();
    } finally { valid.mockRestore(); }
  });
});
