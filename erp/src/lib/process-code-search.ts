import type { ProcessEditorCode } from "./process-editor-catalog";

/** Spec 2026-09-26 §4 "Add": code prefix, then name prefix, then a word start in the name, then
 *  any substring of code or name. Case-insensitive, active codes only, ties by code. */
export function rankProcessCodes(codes: readonly ProcessEditorCode[], query: string): ProcessEditorCode[] {
  const q = query.trim().toLowerCase();
  const tier = (c: ProcessEditorCode): number => {
    if (q === "") return 0;
    const code = c.code.toLowerCase(), name = c.name.toLowerCase();
    if (code.startsWith(q)) return 0;
    if (name.startsWith(q)) return 1;
    if (name.split(/[^a-z0-9]+/).some(word => word.startsWith(q))) return 2;
    return code.includes(q) || name.includes(q) ? 3 : -1;
  };
  return codes.filter(c => c.active).map(c => ({ c, t: tier(c) })).filter(x => x.t >= 0)
    .sort((a, b) => a.t - b.t || a.c.code.localeCompare(b.c.code)).map(x => x.c);
}
