import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SavedViewsBar } from "../src/app/board-parts/SavedViewsBar";

// Ruling R20 (owner 2026-10-22, #683): the board's View select names the selected saved view with
// "(changed)" while the live arrangement differs from its stored one, and Update view writes the
// arrangement into it. The bar is presentational; the page derives `viewChanged` through
// `sameViewConfig` (tests/board-view-changed.test.ts) and sends the PATCH. Update view stays open
// whenever a saved view is selected: a board filter is not held work, so the bar keeps its
// exemption from the unsaved-edit guard (owner's option 1).
const noop = () => {};
const views = [{ id: "v1", name: "Open ACME", config: {}, isDefault: false, updatedAt: "2026-10-22" }];
function bar(over: Partial<Parameters<typeof SavedViewsBar>[0]> = {}) {
  return renderToStaticMarkup(
    <SavedViewsBar savedViews={views} selectedViewId="v1" saveOpen={false} saveName="" saveDefault={false}
                   settingDefault={false} viewChanged={false} updatingView={false} viewError={null}
                   onApplyView={noop} onSetSelectedDefault={noop} onOpenSave={noop} onDeleteView={noop}
                   onSaveNameChange={noop} onSaveDefaultChange={noop} onSaveView={noop} savingView={false} onCancelSave={noop}
                   onUpdateView={noop} {...over} />);
}

describe("SavedViewsBar (R20)", () => {
  it("marks the selected view (changed) while the live arrangement differs, and only then", () => {
    expect(bar({ viewChanged: true })).toContain(">Open ACME (changed)</option>");
    expect(bar()).toContain(">Open ACME</option>");
    expect(bar()).not.toContain("(changed)");
    // The Default board takes no mark.
    expect(bar({ selectedViewId: "", viewChanged: true })).not.toContain("(changed)");
  });

  it("offers Update view while a saved view is selected, held while its PATCH is out, and shows its refusal beside it", () => {
    expect(bar()).toContain(">Update view</button>");
    expect(bar({ selectedViewId: "" })).not.toContain("Update view");
    expect(bar({ updatingView: true })).toMatch(/<button[^>]*disabled=""[^>]*>Updating…<\/button>/);
    expect(bar({ viewError: "Saved view not found" })).toContain("Saved view not found");
  });

  it("holds the save panel's Save while Save view's POST is out (#720)", () => {
    expect(bar({ saveOpen: true })).toMatch(/<button class="[^"]*">Save<\/button>/);
    expect(bar({ saveOpen: true, savingView: true })).toMatch(/<button disabled=""[^>]*>Save<\/button>/);
  });
});

describe("the board page wires Update view (R20)", () => {
  const text = readFileSync(fileURLToPath(new URL("../src/app/page.tsx", import.meta.url)), "utf8");
  it("derives the mark from sameViewConfig over the selected view's stored config, and PATCHes the live config", () => {
    expect(text).toContain("const viewChanged = selectedView !== undefined && !sameViewConfig({ columns, filters, sort: sort.sort, dir: sort.dir }, selectedView.config);");
    expect(text).toContain('method: "PATCH", body: JSON.stringify({ config }),');
    expect(text).toContain("if (!selectedViewId || updatingView) return; // one at a time (#145)");
  });
  // Codex on #733: Update view and Set as default can be out at once, and each answer carries the
  // whole row as the server held it at its own commit, so a handler adopting the row whole could
  // overwrite the other's newer field with an older one. Each lands only the field it wrote.
  it("each PATCH handler lands only the field it wrote, never the whole answered row", () => {
    expect(text).toContain("if (v.id === updated.id) return { ...v, isDefault: updated.isDefault };");
    expect(text).toContain("prev.map((v) => (v.id === updated.id ? { ...v, config: updated.config } : v))");
    expect(text).not.toMatch(/v\.id === updated\.id \? updated : v/);
    expect(text).not.toContain("if (v.id === updated.id) return updated;");
  });
});
