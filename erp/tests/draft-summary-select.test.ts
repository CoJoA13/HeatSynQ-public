import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { selectDraftCount, selectDraftIdentity } from "../src/lib/draft-summary-select";
import { EMPTY_DRAFT_SUMMARY } from "../src/lib/draft-session";
import { openScalarDraft } from "./helpers/draft-store";

// #700: a keystroke in a recoverable editor publishes a new draft summary, and every component
// subscribed to the whole summary rendered again for it. A component that reads only the store's
// identity, or its draft count, subscribes through these selectors, whose answer is the SAME object
// while the fields it names are unchanged, so useSyncExternalStore renders nothing for the keystroke.
describe("draft summary selectors (#700)", () => {
  it("a keystroke publishes a new summary, and the identity answer stays the same object", () => {
    const { store, binding } = openScalarDraft();
    binding.change(() => ({ value: "a" }));
    const summary = store.getSnapshot(); const identity = selectDraftIdentity(summary);
    binding.change(() => ({ value: "ab" }));
    expect(store.getSnapshot()).not.toBe(summary);
    expect(selectDraftIdentity(store.getSnapshot())).toBe(identity);
    expect(identity).toEqual({ owner: summary.owner, identityReady: true });
  });
  it("a keystroke keeps the count answer too, and clearing the draft changes it", () => {
    const { store, binding } = openScalarDraft();
    binding.change(() => ({ value: "a" }));
    const counted = selectDraftCount(store.getSnapshot());
    binding.change(() => ({ value: "ab" }));
    expect(selectDraftCount(store.getSnapshot())).toBe(counted);
    expect(counted.count).toBe(1);
    binding.change(() => ({ value: "saved" }));
    expect(selectDraftCount(store.getSnapshot())).not.toBe(counted);
    expect(selectDraftCount(store.getSnapshot()).count).toBe(0);
  });
  it("answers a new object when the identity changes, and the same one for the same summary", () => {
    const { store } = openScalarDraft();
    const ready = selectDraftIdentity(store.getSnapshot());
    store.beginIdentityCheck();
    const checking = selectDraftIdentity(store.getSnapshot());
    expect(checking).not.toBe(ready);
    expect(checking.identityReady).toBe(false);
    expect(selectDraftIdentity(store.getSnapshot())).toBe(checking);
    expect(selectDraftIdentity(EMPTY_DRAFT_SUMMARY)).toBe(selectDraftIdentity(EMPTY_DRAFT_SUMMARY));
  });
});

// The whole-summary hook renders again on every keystroke in any recoverable editor, so its callers
// are pinned: a new one is a decision, not a convenience. Parsed: a call of the bare identifier.
const WHOLE_SUMMARY_CALLERS = [
  "components/DraftsInTab.tsx", // the open panel lists the rows, and Discard needs their stamps
  "app/admin/templates/[id]/edit/TemplateEditor.tsx", // its retained-slot check reads the rows
];
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
}
describe("whole draft summary subscribers (#700)", () => {
  it("only the listed files call useBrowserDraftStore", () => {
    const root = new URL("../src/", import.meta.url).pathname;
    const callers = sources(root).filter((file) => {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      let found = false;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useBrowserDraftStore") found = true;
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return found;
    }).map((file) => relative(root, file)).sort();
    expect(callers).toEqual([...WHOLE_SUMMARY_CALLERS].sort());
  });
});
