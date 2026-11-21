// Container tag PR 3, Task 6 (owner call C1, 2026-11-13: "Allow, upload only"): the tag withholds the
// header logo, yet its canvas may carry a Logo item, which needs bytes. The editor therefore offers the
// Logo panel's UPLOAD, never its placement, while the config holds a canvas layout.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  CONTAINER_TAG_CONTRACT, CONTAINER_TAG_DEFAULT_CONFIG, TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG,
  type TemplateConfig,
} from "@/lib/template-contracts";
import { editorWithholds, logoUploadOffered } from "@/lib/template-editor";
import { standardLayout } from "./helpers/canvas-fixtures";
import { jsxTags } from "./helpers/jsx-source";
import { callsBareIdentifier } from "./helpers/ts-parse";

const EDIT = "app/admin/templates/[id]/edit";
const path = (rel: string) => fileURLToPath(new URL(`../src/${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(path(rel), "utf8");
const withLayout = (c: TemplateConfig): TemplateConfig => ({ ...c, layout: standardLayout() });

describe("logoUploadOffered", () => {
  it("the tag still withholds its header logo", () => {
    expect(editorWithholds(CONTAINER_TAG_CONTRACT).logo).toBe(true);
  });
  it("the tag offers the upload only while its config holds a canvas layout", () => {
    expect(logoUploadOffered(CONTAINER_TAG_CONTRACT, { ...CONTAINER_TAG_DEFAULT_CONFIG, layout: null })).toBe(false);
    expect(logoUploadOffered(CONTAINER_TAG_CONTRACT, withLayout(CONTAINER_TAG_DEFAULT_CONFIG))).toBe(true);
  });
  it("a contract that withholds nothing always offers it, as today", () => {
    expect(logoUploadOffered(TRAVELER_CONTRACT, { ...TRAVELER_DEFAULT_CONFIG, layout: null })).toBe(true);
    expect(logoUploadOffered(TRAVELER_CONTRACT, withLayout(TRAVELER_DEFAULT_CONFIG))).toBe(true);
  });
});

describe("the editor's source", () => {
  it("offers the upload-only panel when the logo is withheld and logoUploadOffered, placement withheld", () => {
    const file = `${EDIT}/TemplateEditor.tsx`;
    const src = read(file);
    const tags = jsxTags(`src/${file}`);
    expect(tags.filter((t) => t.name === "LogoPanel")).toHaveLength(2); // the eight's, and the upload-only one
    const upload = tags.filter((t) => t.name === "LogoUploadPanel");
    expect(upload).toHaveLength(1);
    expect(src).toMatch(/\{withholds\.logo && logoUploadOffered\(contract, config\) && \(\s*<LogoUploadPanel>\s*<LogoPanel[^>]*placementWithheld \/>/);
    expect(callsBareIdentifier(src, "logoUploadOffered", "TemplateEditor.tsx")).toBe(true);
  });
  it("the eight's own LogoPanel is untouched and passes no placementWithheld", () => {
    const src = read(`${EDIT}/TemplateEditor.tsx`);
    expect(src).toMatch(/\{!withholds\.logo && \(\s*<LogoPanel(?![^>]*placementWithheld)/);
  });
  it("LogoPanel hides the placement and width when the placement is withheld", () => {
    const src = read(`${EDIT}/LogoPanel.tsx`);
    expect(src).toContain("placementWithheld = false");
    expect(src).toMatch(/config\.layout !== null \? <p[^\n]*logoPlaced[^\n]*<\/p> : placementWithheld \? null : \(/);
    // the upload (FileChooser) is not under that condition
    const sf = ts.createSourceFile("LogoPanel.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let chooserInPlacementBranch = false;
    const visit = (n: ts.Node, inside: boolean): void => {
      const isBranch = ts.isConditionalExpression(n) && n.condition.getText(sf) === "placementWithheld";
      if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(sf) === "FileChooser" && inside) chooserInPlacementBranch = true;
      ts.forEachChild(n, (c) => visit(c, inside || isBranch));
    };
    visit(sf, false);
    expect(chooserInPlacementBranch).toBe(false);
  });
});
