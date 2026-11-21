// The draft-recovery notice's sentences, stated once in src/lib/draft-recovery-words.ts (#483). The
// notice renders one per editor mode; a grid's gate (`gridGate`) and an empty Add picker's text
// (`pickerEmptyReason`), both in shipment-gates.ts, reuse the first sentence of the three modes that
// hold no draft to show. This file pins the words, proves the notice renders them, and proves the
// notice no longer types any of them itself: parsed, never pattern-matched (#188).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DraftRecoveryNotice } from "../src/components/DraftRecoveryNotice";
import {
  CHECKING_ACCESS, DRAFT_RECOVERY_MESSAGES, EDITOR_NOT_LOADED, EDITOR_UNAVAILABLE, RETAINED_VALUES_HIDDEN,
  editorAccessSentence, type EditorMode,
} from "../src/lib/draft-recovery-words";

/** Every mode of `EditorView` (draft-store.ts), written out. A mode added there and to the record
 *  but not here reds (a). */
const MODES = [
  "loading", "editing", "offer", "conflict", "blocked-two-copies", "pending", "unknown", "unavailable", "error", "completed",
] as const satisfies readonly EditorMode[];

/** The ten sentences, byte for byte as DraftRecoveryNotice.tsx carried them inline before #483. */
const SENTENCES: Record<EditorMode, string> = {
  loading: "Checking access to this editor…", editing: "An earlier copy is retained below.",
  offer: "Unsaved changes are available in this tab. Restore them to continue editing.",
  conflict: "The saved record changed or is read-only. Review your retained copy before starting fresh.",
  "blocked-two-copies": "Two copies are retained. Dismiss one before starting another copy. Editing is paused.",
  pending: "A save is in progress. Leaving or discarding will not cancel the submitted request.",
  unknown: "The save result is unknown. Check the saved record before taking another action. Editing is paused.",
  unavailable: "This editor is unavailable. Retained values are hidden until access is confirmed.",
  error: "This editor could not be loaded. Retained values are hidden until access is confirmed.", completed: "",
};

describe("the notice's sentences, stated once", () => {
  it("(a) the record holds the ten sentences the notice carried, one for every mode", () => {
    expect(DRAFT_RECOVERY_MESSAGES).toEqual(SENTENCES);
    expect([...MODES].sort()).toEqual(Object.keys(DRAFT_RECOVERY_MESSAGES).sort());
  });

  it("(b) the three modes with no draft to show are built from the four constants", () => {
    expect(CHECKING_ACCESS).toBe("Checking access to this editor…");
    expect(EDITOR_UNAVAILABLE).toBe("This editor is unavailable.");
    expect(EDITOR_NOT_LOADED).toBe("This editor could not be loaded.");
    expect(RETAINED_VALUES_HIDDEN).toBe("Retained values are hidden until access is confirmed.");
    expect(DRAFT_RECOVERY_MESSAGES.loading).toBe(CHECKING_ACCESS);
    expect(DRAFT_RECOVERY_MESSAGES.unavailable).toBe(`${EDITOR_UNAVAILABLE} ${RETAINED_VALUES_HIDDEN}`);
    expect(DRAFT_RECOVERY_MESSAGES.error).toBe(`${EDITOR_NOT_LOADED} ${RETAINED_VALUES_HIDDEN}`);
  });

  it("(e) editorAccessSentence is the first sentence of loading, unavailable and error, and nothing in the other seven", () => {
    expect(editorAccessSentence("loading")).toBe(CHECKING_ACCESS);
    expect(editorAccessSentence("unavailable")).toBe(EDITOR_UNAVAILABLE);
    expect(editorAccessSentence("error")).toBe(EDITOR_NOT_LOADED);
    for (const mode of ["loading", "unavailable", "error"] as const) {
      expect(DRAFT_RECOVERY_MESSAGES[mode].startsWith(editorAccessSentence(mode)!), mode).toBe(true);
    }
    const others = MODES.filter(m => m !== "loading" && m !== "unavailable" && m !== "error");
    expect(others).toHaveLength(7);
    for (const mode of others) expect(editorAccessSentence(mode), mode).toBeUndefined();
  });
});

// ---- (c) the notice renders the record ----

const noop = () => {};
function notice(mode: EditorMode, over: Partial<Parameters<typeof DraftRecoveryNotice>[0]> = {}): string {
  return renderToStaticMarkup(<DraftRecoveryNotice mode={mode} canRestore={false} hasCurrent={false} hasReference={false}
    restore={noop} discard={noop} retryRead={noop} {...over} />);
}
/** The text of the notice's one `<p role="status">`. None of the ten sentences holds a character
 *  React escapes. */
function statusText(html: string): string {
  const found = [...html.matchAll(/<p role="status">([^<]*)<\/p>/g)].map(m => m[1]);
  expect(found, html).toHaveLength(1);
  return found[0];
}

describe("(c) the notice renders the record's sentence in each mode it renders", () => {
  // Bare props render seven modes. `editing` renders only over an earlier copy, `conflict` only with
  // something retained, and `completed` never: the owning editor shows its receipt.
  const props: Record<Exclude<EditorMode, "completed">, Partial<Parameters<typeof DraftRecoveryNotice>[0]>> = {
    loading: {}, editing: { hasReference: true }, offer: {}, conflict: { hasCurrent: true }, "blocked-two-copies": {},
    pending: {}, unknown: {}, unavailable: {}, error: {},
  };

  it.each(Object.keys(props) as Exclude<EditorMode, "completed">[])("%s", (mode) => {
    expect(statusText(notice(mode, props[mode]))).toBe(DRAFT_RECOVERY_MESSAGES[mode]);
  });

  it("completed renders nothing", () => {
    expect(notice("completed", { hasCurrent: true, hasReference: true })).toBe("");
  });

  it("a rejected save's rollback keeps its own sentence, which is none of the ten", () => {
    expect(statusText(notice("pending", { submissionPhase: "rollback" }))).toBe("Save rejected; refreshing draft.");
    expect(statusText(notice("editing", { submissionPhase: "rollback" }))).toBe("Save rejected; refreshing draft.");
  });
});

// ---- (d) the notice types none of the sentences itself ----

const noticeFile = fileURLToPath(new URL("../src/components/DraftRecoveryNotice.tsx", import.meta.url));

/** Every string literal, template text and JSX text in the notice's source, as the parser reads it. */
function literalsIn(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) found.push(node.text);
    else if (ts.isJsxText(node)) found.push(node.text.trim());
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

describe("(d) DraftRecoveryNotice.tsx holds none of the sentences as a literal", () => {
  it("reads the record, and retypes no sentence and no constant", () => {
    const literals = literalsIn(noticeFile);
    // The walk sees the file's literals: the rollback sentence, a JSX button label and a mode name.
    expect(literals).toContain("Save rejected; refreshing draft.");
    expect(literals).toContain("Restore");
    expect(literals).toContain("conflict");
    // `completed`'s "" is left out: every text contains it.
    const sentences = [
      ...Object.values(SENTENCES).filter(s => s !== ""),
      CHECKING_ACCESS, EDITOR_UNAVAILABLE, EDITOR_NOT_LOADED, RETAINED_VALUES_HIDDEN,
    ];
    expect(sentences).toHaveLength(13);
    // The rule of tests/waiting-titles.test.ts's sweep: white space collapsed in each text, and a
    // text that CONTAINS a sentence counts, so a sentence retyped inside a longer literal or a
    // template's piece (`${EDITOR_UNAVAILABLE} Retained values …`) reds, failing closed.
    const texts = literals.map(text => text.replace(/\s+/g, " "));
    for (const sentence of sentences) expect(texts.filter(text => text.includes(sentence)), sentence).toEqual([]);
  });
});
