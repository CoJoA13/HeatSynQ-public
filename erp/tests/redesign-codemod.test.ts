// The redesign's class codemod (PR 1b, spec 2026-10-30-ux-redesign-design.md §4.3, §4.6): the
// element-aware composites, the token map, the leftovers, the import, and idempotence (the plan's
// review focus 1–4). It was run once over `src/` and `--check` keeps it a no-op from then on.
import { describe, expect, it } from "vitest";
import { rewriteSource } from "../scripts/codemods/redesign-classes.mjs";

const wrap = (jsx: string, head = `"use client";\n`) => `${head}export const X = () => (\n  ${jsx}\n);\n`;
const IMPORT = (names: string) => `import { ${names} } from "@/lib/ui-classes";`;

describe("redesign class codemod", () => {
  const cases: [string, string, string][] = [
    [
      `<button className="rounded bg-slate-800 px-3 py-1 text-sm text-white">a</button>`,
      `<button className={BUTTON_PRIMARY_COMPACT}>a</button>`,
      "BUTTON_PRIMARY_COMPACT",
    ],
    [
      `<button className="w-full rounded bg-slate-800 py-2 text-white">a</button>`,
      "<button className={`${BUTTON_PRIMARY_COMPACT} w-full`}>a</button>",
      "BUTTON_PRIMARY_COMPACT",
    ],
    [
      `<input className="mt-1 w-full rounded border px-2 py-1 disabled:cursor-not-allowed disabled:bg-slate-100" />`,
      "<input className={`${INPUT_COMPACT} mt-1 w-full disabled:cursor-not-allowed disabled:bg-surface-50`} />",
      "INPUT_COMPACT",
    ],
    [
      `<p className="mb-3 whitespace-pre-line rounded bg-red-50 p-2 text-sm text-red-700">a</p>`,
      "<p className={`${NOTICE.refusal} mb-3 whitespace-pre-line`}>a</p>",
      "NOTICE",
    ],
    [
      `<a className="text-sm text-blue-700 underline">a</a>`,
      "<a className={`${LINK} text-sm`}>a</a>",
      "LINK",
    ],
  ];

  it.each(cases)("rewrites %s", (before, after, names) => {
    const out = rewriteSource(wrap(before), "x.tsx");
    expect(out.changed).toBe(true);
    expect(out.imports).toEqual(names.split(", "));
    expect(out.text).toBe(wrap(after, `"use client";\n${IMPORT(names)}\n`));
  });

  it("rewrites a token inside a template span, keeping the shape (review focus 2)", () => {
    const out = rewriteSource(wrap("<tr className={`border-t ${active ? \"bg-slate-100\" : \"\"}`}>a</tr>"), "x.tsx");
    expect(out.text).toBe(wrap("<tr className={`border-t ${active ? \"bg-surface-50\" : \"\"}`}>a</tr>"));
    expect(out.imports).toEqual([]);
  });

  it("merges into an existing ui-classes import", () => {
    const src = `"use client";\n${IMPORT("CARD")}\nimport x from "y";\nexport const X = () => <a className="text-blue-700 underline">a</a>;\n`;
    const out = rewriteSource(src, "x.tsx");
    expect(out.text).toBe(`"use client";\n${IMPORT("CARD, LINK")}\nimport x from "y";\nexport const X = () => <a className={LINK}>a</a>;\n`);
  });

  it("adds the import after the last import, after the directive when there is none", () => {
    const withImports = `import a from "a";\nimport b from "b";\nexport const X = () => <a className="text-blue-700 underline">a</a>;\n`;
    expect(rewriteSource(withImports, "x.tsx").text)
      .toBe(`import a from "a";\nimport b from "b";\n${IMPORT("LINK")}\nexport const X = () => <a className={LINK}>a</a>;\n`);
    const bare = `export const X = () => <a className="text-blue-700 underline">a</a>;\n`;
    expect(rewriteSource(bare, "x.tsx").text).toBe(`${IMPORT("LINK")}\nexport const X = () => <a className={LINK}>a</a>;\n`);
  });

  it("maps a token under an opacity suffix and the border, ring and banner tokens the tree holds", () => {
    const src = wrap(`<dialog className="backdrop:bg-slate-900/50 bg-slate-50/50 border-amber-400 border-amber-600 outline-blue-600 border-blue-600 border-blue-300 bg-amber-500 text-amber-950 focus-within:ring-slate-500" />`);
    expect(rewriteSource(src, "x.tsx").text)
      .toBe(wrap(`<dialog className="backdrop:bg-ink-900/50 bg-surface-50/50 border-accent-400 border-accent-600 outline-accent-600 border-link-700 border-line bg-accent-400 text-ink-900 focus-within:ring-ink-500" />`));
  });

  it("refuses a composite whose identifier would fight a token the site keeps (size, shape, padding, colour)", () => {
    const keep = (jsx: string) => expect(rewriteSource(wrap(jsx), "x.tsx").text).toBe(wrap(jsx));
    keep(`<input className="rounded border px-1 text-xs" />`);
    keep(`<button className="rounded bg-ink-900 px-3 py-1 text-xs text-white">a</button>`);
    keep(`<div className="rounded bg-surface-50 p-2 text-xs">a</div>`);
    keep(`<div className="rounded border bg-surface-0 p-4 text-sm">a</div>`);
    const out = rewriteSource(wrap(`<button className="rounded border border-amber-600 px-3 py-1 text-sm text-amber-800">a</button>`), "x.tsx");
    expect(out.text).toBe(wrap(`<button className="rounded border border-accent-600 px-3 py-1 text-sm text-accent-600">a</button>`));
    expect(out.imports).toEqual([]);
  });

  it("consumes a white fill on a bordered control, which the identifier carries", () => {
    expect(rewriteSource(wrap(`<button className="rounded border bg-white px-3 py-1 text-sm">a</button>`), "x.tsx").text)
      .toBe(wrap(`<button className={BUTTON_NEUTRAL_COMPACT}>a</button>`, `"use client";\n${IMPORT("BUTTON_NEUTRAL_COMPACT")}\n`));
    expect(rewriteSource(wrap(`<select className="rounded border bg-white px-2 py-1 text-sm" />`), "x.tsx").text)
      .toBe(wrap(`<select className={INPUT_COMPACT} />`, `"use client";\n${IMPORT("INPUT_COMPACT")}\n`));
  });

  it("takes the old danger badge's own red text as the identifier's", () => {
    expect(rewriteSource(wrap(`<span className="ml-2 rounded bg-red-100 px-1 text-xs text-red-800">voided</span>`), "x.tsx").text)
      .toBe(wrap("<span className={`${BADGE_DANGER} ml-2`}>voided</span>", `"use client";\n${IMPORT("BADGE_DANGER")}\n`));
  });

  it("leaves a file with nothing to rewrite", () => {
    const src = wrap(`<p className="text-sm text-ink-500 bg-red-50">a</p>`);
    expect(rewriteSource(src, "x.tsx")).toEqual({ text: src, changed: false, imports: [] });
  });

  it("is idempotent (review focus 4)", () => {
    for (const [before] of cases) {
      const once = rewriteSource(wrap(before), "x.tsx").text;
      expect(rewriteSource(once, "x.tsx")).toEqual({ text: once, changed: false, imports: [] });
    }
  });
});
