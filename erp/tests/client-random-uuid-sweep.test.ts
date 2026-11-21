// #348: client code never names `randomUUID` directly. It must call `newId()` (src/lib/client-id.ts).
//
// Browsers expose `crypto.randomUUID()` only in a secure context. On the plain-HTTP LAN origin the
// RC12 test installation is browsed at, it is `undefined`, so each direct call threw a `TypeError`
// and Add step did nothing. No other gate can see a new one: vitest runs in Node, where the
// function always exists, and every E2E flow except `insecure-origin` browses `http://localhost`,
// which is a secure context.
//
// SCOPE: every `.ts`/`.tsx` file under `src/`, derived by walking the tree and never hand-listed,
// except for exactly two exclusions. `src/server/**` runs in Node, where the function always exists.
// `src/lib/client-id.ts` is the one sanctioned reader. That puts route handlers and shared
// `src/lib` modules in scope too. That is deliberate: which of those a browser bundle reaches is a
// graph question the import can change at any time, and `newId()` is correct in Node as well.
//
// FAILS CLOSED, and is PARSED, never pattern-matched (#188; the primitive and the shapes it
// counts are documented at `linesNaming` in tests/helpers/ts-parse.ts). Any identifier or exact
// string literal spelling `randomUUID` counts, on any receiver, called or not. The escape hatch is
// `newId()`, never an exemption here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { linesNaming } from "./helpers/ts-parse";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const LEAF = "src/lib/client-id.ts";
const NAME = "randomUUID";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const everyFile = walk(SRC).map((full) => relative(ROOT, full).split(sep).join("/"));
const code = everyFile.filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
const swept = code.filter((file) => !file.startsWith("src/server/") && file !== LEAF);
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("linesNaming (the parsed primitive the sweep asks)", () => {
  it.each([
    ["dot access on crypto", "const id = crypto.randomUUID();"],
    ["globalThis receiver", "const id = globalThis.crypto.randomUUID();"],
    ["window receiver", "const id = window.crypto.randomUUID();"],
    ["self receiver", "const id = self.crypto.randomUUID();"],
    ["an alias", "const c = crypto;\nconst id = c.randomUUID();"],
    ["optional chaining", "const id = crypto?.randomUUID?.();"],
    ["an uncalled reference", "const mint = crypto.randomUUID.bind(crypto);"],
    ["double-quoted element access", 'const id = crypto["randomUUID"]();'],
    ["single-quoted element access", "const id = crypto['randomUUID']();"],
    ["template element access", "const id = crypto[`randomUUID`]();"],
    ["a destructured binding", "const { randomUUID } = crypto;"],
    ["a renamed destructured binding", "const { randomUUID: mint } = crypto;"],
    ["Reflect.get", 'const f = Reflect.get(crypto, "randomUUID");'],
    ["an `in` check", 'const has = "randomUUID" in crypto;'],
    ["an import specifier", 'import { randomUUID } from "node:crypto";'],
    ["inside a JSX handler", "const x = <button onClick={() => crypto.randomUUID()} />;"],
  ])("counts %s", (_label, src) => {
    expect(linesNaming(src, NAME).length).toBeGreaterThan(0);
  });

  it.each([
    ["a line comment", "// crypto.randomUUID()\nconst id = newId();"],
    ["a block comment", "/* crypto.randomUUID() */ const id = newId();"],
    ["a docblock", "/** Uses `crypto.randomUUID()` when present. */\nexport function f() { return newId(); }"],
    ["a longer string", 'const hint = "call crypto.randomUUID()";'],
    ["template text", "const hint = `use randomUUID here`;"],
    ["JSX text", "const x = <p>crypto.randomUUID()</p>;"],
    ["a regex literal", "const r = /randomUUID/;"],
    ["a different identifier", "const randomUUIDs = 1; const id = newId();"],
  ])("does not count %s", (_label, src) => {
    expect(linesNaming(src, NAME)).toEqual([]);
  });

  it("reports each offending line once, in order, and parses a .ts module as TS", () => {
    // Line 3 is an angle-bracket type assertion, legal only in a .ts module. Parsed as TSX it
    // opens a JSX element instead, the rest of the file becomes JSX text, and line 4's reference
    // vanishes. So only a genuine TS parse of a .ts file reports line 4. Line 4 must hold no
    // braces: TSX would read `{ … }` in that text as an expression and still see the name.
    const src = [
      "const a = crypto.randomUUID(); const b = crypto['randomUUID']();", // line 1, twice
      "// crypto.randomUUID() in a comment",                               // line 2, no
      "const n = <number>value;",                                          // line 3, no
      "const c = globalThis.crypto.randomUUID();",                         // line 4
    ].join("\n");
    expect(linesNaming(src, NAME, "candidate.ts")).toEqual([1, 4]);
  });

  it("sees a reference behind a .ts angle-bracket assertion, which a TSX parse would hide", () => {
    expect(linesNaming("const id = <string>crypto.randomUUID();", NAME, "candidate.ts")).toEqual([1]);
  });
});

describe("client code never names randomUUID (#348)", () => {
  it("covers a real tree: every .ts/.tsx under src/, both extensions, and no other script type", () => {
    // Non-vacuous floors. A walk that found nothing, or only one extension, would pass the sweep
    // below trivially.
    expect(swept.length).toBeGreaterThan(300);
    expect(swept.some((file) => file.endsWith(".tsx"))).toBe(true);
    expect(swept.some((file) => file.endsWith(".ts"))).toBe(true);
    // The extension filter is exhaustive only while src/ holds no other script type.
    expect(everyFile.filter((file) => /\.(?:[cm]?jsx?|mts|cts)$/.test(file))).toEqual([]);
    // Exactly the two stated exclusions: nothing outside src/server/ is skipped except the leaf.
    expect(code.filter((file) => !swept.includes(file) && !file.startsWith("src/server/"))).toEqual([LEAF]);
  });

  it("recognises the sanctioned leaf's own use, so the exemption hides a real reference", () => {
    // If the detector could not see the leaf's `source.randomUUID`, the exemption would be hiding
    // nothing and the sweep below would be vacuous.
    expect(linesNaming(read(LEAF), NAME, LEAF).length).toBeGreaterThan(0);
  });

  it("finds no randomUUID reference outside src/server/** and the leaf", () => {
    const offenders = swept.flatMap((file) =>
      linesNaming(read(file), NAME, file).map((line) => `${file}:${line}`));
    expect(offenders, `call newId() from src/lib/client-id.ts instead (#348): ${offenders.join(", ")}`)
      .toEqual([]);
  });
});
