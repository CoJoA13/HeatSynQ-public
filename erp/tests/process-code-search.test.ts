import { describe, expect, it } from "vitest";
import { rankProcessCodes } from "../src/lib/process-code-search";
import type { ProcessEditorCode } from "../src/lib/process-editor-catalog";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

const editorCode = (code: string, name: string, active = true): ProcessEditorCode =>
  deepFreeze({ id: `id-${code}`, code, name, active, defaultInstruction: "", fields: [] });

// Spec 2026-09-26 §4 "Add": code prefix, then name prefix, then a word start in the name, then any
// substring of code or name. CLEAN's name STARTS WITH "Wash" (pre-flight T7-2): unlike WASH alone,
// whose code is the only thing in this catalog containing "wash", this pair proves a code-prefix
// match outranks a name-prefix match on a DIFFERENT code, not just that WASH matches at all.
const codes: readonly ProcessEditorCode[] = deepFreeze([
  editorCode("HT-100", "Neutral Harden"),
  editorCode("HT-600", "Cryogenic Treat"),
  editorCode("HARD", "Hardness check"),
  editorCode("WASH", "Hot Wash"),
  editorCode("CLEAN", "Wash and dry"),
  editorCode("HT-900", "Old", false),
]);

describe("rankProcessCodes", () => {
  it("ranks a code-prefix match ahead of a name-only match, ties broken by code", () => {
    // HARD matches neither a code prefix nor a name word ("hardness check" has no "ht"), so it is
    // absent rather than merely ranked lower.
    expect(rankProcessCodes(codes, "ht").map(c => c.code)).toEqual(["HT-100", "HT-600"]);
  });

  it("ranks a code-prefix match ahead of a word-start-in-name match", () => {
    expect(rankProcessCodes(codes, "har").map(c => c.code)).toEqual(["HARD", "HT-100"]);
  });

  it("ranks a code-prefix match ahead of a name-prefix match on a different code", () => {
    expect(rankProcessCodes(codes, "wash").map(c => c.code)).toEqual(["WASH", "CLEAN"]);
  });

  it("finds a plain substring when nothing ranks higher", () => {
    expect(rankProcessCodes(codes, "ryo").map(c => c.code)).toEqual(["HT-600"]);
  });

  it("never returns an inactive code, even when only it would match", () => {
    // Only the inactive HT-900 ("Old") matches "old"; every other code is unrelated.
    expect(rankProcessCodes(codes, "old")).toEqual([]);
  });

  it("returns every active code sorted by code for an empty query", () => {
    expect(rankProcessCodes(codes, "").map(c => c.code)).toEqual(["CLEAN", "HARD", "HT-100", "HT-600", "WASH"]);
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(rankProcessCodes(codes, "  Ht  ").map(c => c.code)).toEqual(["HT-100", "HT-600"]);
  });
});
