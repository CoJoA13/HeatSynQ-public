// #678: two controls that read a permission no longer take a read that is out, or one that failed,
// for no grants. The template editor's preview pane trusts the editor's own permission read and
// shows the shared "Loading…" line until it answers (`previewListAccess`,
// src/lib/template-editor.ts); the practice reset button carries no "Requires admin.edit" title
// until its read has answered, and names a failed read beside itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PreviewPane } from "../src/app/admin/templates/[id]/edit/PreviewPane";
import { PracticeResetControl } from "../src/app/practice/PracticeResetControl";
import { defaultConfigFor } from "../src/lib/template-contracts";
import { previewListAccess } from "../src/lib/template-editor";
import { jsxTags } from "./helpers/jsx-source";
import { all } from "./helpers/source-lift";

describe("previewListAccess", () => {
  it("a read that has not answered is pending, never denied", () => {
    expect(previewListAccess(undefined, "orders.view")).toBe("pending");
  });
  it("an answer without the list permission is denied, and one with it allowed", () => {
    expect(previewListAccess([], "orders.view")).toBe("denied");
    expect(previewListAccess(["templates.view"], "orders.view")).toBe("denied");
    expect(previewListAccess(["orders.view"], "orders.view")).toBe("allowed");
  });
});

describe("the preview pane", () => {
  const pane = (perms: readonly string[] | undefined) => renderToStaticMarkup(
    <PreviewPane templateId="t-1" docType="TRAVELER" config={defaultConfigFor("TRAVELER")} perms={perms}
                 recordId="" onRecordId={() => {}} allLoads={false} onAllLoads={() => {}}
                 asOf="" onAsOf={() => {}} combineFamily={false} onCombineFamily={() => {}} />,
  );

  it("while the editor's permission read is out it says Loading…, and names no permission", () => {
    const html = pane(undefined);
    expect(html).toContain(">Loading…</p>");
    expect(html).not.toContain("requires the");
    expect(html).not.toContain("Generate preview");
  });

  it("an answer without orders.view keeps the permission notice", () => {
    const html = pane(["templates.view"]);
    expect(html).toContain("Picking an order to preview requires the <code>orders.view</code> permission.");
    expect(html).not.toContain(">Loading…</p>");
  });

  it("an answer with orders.view offers the picker", () => {
    const html = pane(["templates.view", "orders.view"]);
    expect(html).toContain("Generate preview");
    expect(html).not.toContain("requires the");
  });

  it("sends no permission read of its own, and the editor hands it its own", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/app/admin/templates/[id]/edit/PreviewPane.tsx", import.meta.url)), "utf8");
    expect(src).not.toContain("usePermissions");
    const mounts = jsxTags("src/app/admin/templates/[id]/edit/TemplateEditor.tsx").filter((t) => t.name === "PreviewPane");
    // Two mounts since PR C's Task 6 (the Preview tab's pane and the Design panel's live page), both
    // handed the editor's own read.
    expect(mounts).toHaveLength(2);
    for (const mount of mounts) expect(mount.attr("perms")).toBe("view.savedBaseline?.permissions");
  });

  it("the live page (autoRun) offers the picker without Generate preview", () => {
    const html = renderToStaticMarkup(
      <PreviewPane templateId="t-1" docType="TRAVELER" config={defaultConfigFor("TRAVELER")} perms={["templates.view", "orders.view"]}
                   recordId="" onRecordId={() => {}} allLoads={false} onAllLoads={() => {}}
                   asOf="" onAsOf={() => {}} combineFamily={false} onCombineFamily={() => {}} autoRun onMeasure={() => {}} />,
    );
    expect(html).toContain('aria-label="Preview record"');
    expect(html).not.toContain("Generate preview");
  });
});

describe("the practice reset control", () => {
  it("while its permission read is out the button is disabled and carries no title", () => {
    const html = renderToStaticMarkup(<PracticeResetControl />);
    const button = /<button[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toContain("disabled");
    expect(button).not.toContain("title=");
  });

  it("titles the button from the gate only once the read has answered, and draws a failed read", () => {
    const file = "src/app/practice/PracticeResetControl.tsx";
    const [button] = jsxTags(file).filter((t) => t.name === "button");
    expect(button.attr("title")).toBe("permissions === undefined ? undefined : editGate.title");
    const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const drawn = all(source, ts.isJsxExpression).map((e) => e.expression).filter((e): e is ts.BinaryExpression =>
      !!e && ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && ts.isIdentifier(e.left) && e.left.text === "permsError");
    expect(drawn).toHaveLength(1);
    expect(drawn[0].right.getText(source)).toContain("{permsError}");
  });
});
