import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEARCH_DEBOUNCE_MS, debounceInput, debounceStart, debounceTick } from "../src/lib/debounce";

// Ruling R3 (2026-10-22 review, #612; landing unit 24, PR A): the five list searches read on a
// 250 ms wait after the last keystroke, not on every keystroke. The rule is the pure leaf
// `src/lib/debounce.ts` (a typed value is pending until its wait ends; another keystroke restarts
// the wait; typing back the settled value cancels the pending one), `useDebouncedValue` is that
// rule on React's clock, run here through the fake hook runtime the quote scheduling test uses,
// and the five pages build their query, and their Excel export link, from the debounced term
// while the box keeps the raw text; the pins read each page's source.

describe("debounce leaf (#612)", () => {
  it("waits 250 ms", () => { expect(SEARCH_DEBOUNCE_MS).toBe(250); });

  it("a typed value is pending until its wait ends, and another keystroke restarts the wait", () => {
    const start = debounceStart("");
    expect(start).toEqual({ settled: "", pending: null });
    const typed = debounceInput(start, "4", 1000, 250);
    expect(typed).toEqual({ settled: "", pending: { value: "4", dueAt: 1250 } });
    expect(debounceTick(typed, 1249)).toBe(typed);
    const more = debounceInput(typed, "44", 1200, 250);
    expect(more).toEqual({ settled: "", pending: { value: "44", dueAt: 1450 } });
    expect(debounceTick(more, 1250)).toBe(more);
    expect(debounceTick(more, 1450)).toEqual({ settled: "44", pending: null });
  });

  it("typing the settled value back cancels the pending one, and a settled state ticks to itself", () => {
    const typed = debounceInput(debounceStart("ab"), "abc", 0, 250);
    expect(debounceInput(typed, "ab", 100, 250)).toEqual({ settled: "ab", pending: null });
    const settled = debounceStart("ab");
    expect(debounceTick(settled, 5000)).toBe(settled);
    expect(debounceInput(settled, "ab", 0, 250)).toBe(settled);
  });
});

function runtime() {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void; setter?: (value: unknown) => void };
  const slots: Slot[] = []; let cursor = 0; let renderNeeded = true;
  let queued: (() => void)[] = []; let render: () => void = () => {};
  const changed = (a: readonly unknown[] | undefined, b: readonly unknown[]) => !a || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  function useState(initial: unknown) {
    const index = cursor++; const slot = slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
    slot.setter ??= value => {
      const next = typeof value === "function" ? value(slot.value) : value;
      if (!Object.is(next, slot.value)) { slot.value = next; renderNeeded = true; }
    };
    return [slot.value, slot.setter];
  }
  function useEffect(effect: () => (() => void) | void, deps: readonly unknown[]) {
    const slot = slots[cursor++] ??= {};
    if (changed(slot.deps, deps)) { slot.deps = deps; queued.push(() => { slot.cleanup?.(); slot.cleanup = effect() ?? undefined; }); }
  }
  return { hooks: { useState, useEffect }, mount(fn: () => void) { render = fn; }, remount() { renderNeeded = true; }, async flush() {
    for (let turn = 0; turn < 30; turn++) {
      if (renderNeeded) { renderNeeded = false; cursor = 0; render(); const effects = queued; queued = []; effects.forEach(effect => effect()); }
      await Promise.resolve();
    }
    expect(renderNeeded).toBe(false);
  } };
}

/** The production hook, its imports replaced by the fake runtime's hooks and the real leaf. */
function liftedHook() {
  const text = readFileSync(new URL("../src/lib/use-debounced-value.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("use-debounced-value.ts", text, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(ast).replace(/^export /, "")).join("\n");
  const js = ts.transpileModule(`${body}\nreturn useDebouncedValue;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const hooks = runtime();
  const environment = { ...hooks.hooks, SEARCH_DEBOUNCE_MS, debounceStart, debounceInput, debounceTick };
  const useDebouncedValue = new Function(...Object.keys(environment), js)(...Object.values(environment)) as (value: string, wait?: number, settleKey?: unknown) => string;
  return { hooks, useDebouncedValue };
}

describe("useDebouncedValue (#612)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("answers the first value at once, then each typed value 250 ms after the last keystroke", async () => {
    const { hooks, useDebouncedValue } = liftedHook();
    let typed = "4"; let seen = "";
    hooks.mount(() => { seen = useDebouncedValue(typed); });
    await hooks.flush(); expect(seen).toBe("4");
    typed = "44"; hooks.remount(); await hooks.flush(); expect(seen).toBe("4");
    vi.advanceTimersByTime(200); await hooks.flush(); expect(seen).toBe("4");
    typed = "447"; hooks.remount(); await hooks.flush();
    vi.advanceTimersByTime(200); await hooks.flush(); expect(seen).toBe("4");
    vi.advanceTimersByTime(50); await hooks.flush(); expect(seen).toBe("447");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("typing the settled value back within the wait sends nothing new and leaves no timer", async () => {
    const { hooks, useDebouncedValue } = liftedHook();
    let typed = "ab"; const answers: string[] = [];
    hooks.mount(() => { answers.push(useDebouncedValue(typed)); });
    await hooks.flush();
    typed = "abc"; hooks.remount(); await hooks.flush();
    typed = "ab"; hooks.remount(); await hooks.flush();
    vi.advanceTimersByTime(1000); await hooks.flush();
    expect(new Set(answers)).toEqual(new Set(["ab"]));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useDebouncedValue's settle key (#668)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a changed key answers the value as it stands in that same render, and only later changes wait", async () => {
    const { hooks, useDebouncedValue } = liftedHook();
    let value = ""; let ready = false; const answers: string[] = [];
    hooks.mount(() => { answers.push(useDebouncedValue(value, 250, ready)); });
    await hooks.flush(); expect(answers.at(-1)).toBe("");
    // A resumed draft: its date and its readiness arrive in one render, and are read at once.
    value = "2026-10-01"; ready = true; hooks.remount(); await hooks.flush();
    expect(answers.at(-1)).toBe("2026-10-01");
    expect(vi.getTimerCount()).toBe(0);
    // Typing afterwards waits as before.
    value = "2026-10-02"; hooks.remount(); await hooks.flush(); expect(answers.at(-1)).toBe("2026-10-01");
    vi.advanceTimersByTime(250); await hooks.flush(); expect(answers.at(-1)).toBe("2026-10-02");
  });

  it("a changed key drops a value still waiting and settles the one that stands", async () => {
    const { hooks, useDebouncedValue } = liftedHook();
    let value = "a"; let key = 0; const answers: string[] = [];
    hooks.mount(() => { answers.push(useDebouncedValue(value, 250, key)); });
    await hooks.flush();
    value = "ab"; hooks.remount(); await hooks.flush(); expect(answers.at(-1)).toBe("a");
    key = 1; hooks.remount(); await hooks.flush(); expect(answers.at(-1)).toBe("ab");
    vi.advanceTimersByTime(1000); await hooks.flush(); expect(answers.at(-1)).toBe("ab");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the five list searches read the debounced term (#612)", () => {
  const read = (path: string) => readFileSync(new URL(`../src/app/${path}`, import.meta.url), "utf8");
  const pages: Array<[string, string[]]> = [
    ["page.tsx", ['import { useDebouncedValue } from "@/lib/use-debounced-value";', "const debouncedSearch = useDebouncedValue(filters.search);", "buildOrderQuery({ ...filters, search: debouncedSearch }, sort)"]],
    ["shipping/ShippingList.tsx", ['import { useDebouncedValue } from "@/lib/use-debounced-value";', "const debouncedSearch = useDebouncedValue(filters.search);", "buildQuery({ ...filters, search: debouncedSearch })", "value={filters.search}"]],
    ["quotes/Quotes.tsx", ['import { useDebouncedValue } from "@/lib/use-debounced-value";', "const debouncedSearch = useDebouncedValue(filters.search);", "buildQuery({ ...filters, search: debouncedSearch })", "value={filters.search}"]],
    ["parts/page.tsx", ['import { useDebouncedValue } from "@/lib/use-debounced-value";', "const debouncedSearch = useDebouncedValue(search);", "search=${encodeURIComponent(debouncedSearch)}", "value={search}"]],
    ["customers/page.tsx", ['import { useDebouncedValue } from "@/lib/use-debounced-value";', "const debouncedSearch = useDebouncedValue(search);", "search=${encodeURIComponent(debouncedSearch)}", "value={search}"]],
  ];
  for (const [path, needles] of pages) it(`${path} builds its query from the debounced term and keeps the raw text in the box`, () => {
    const source = read(path);
    for (const needle of needles) expect(source, needle).toContain(needle);
    // The query, and so the Excel export link built from it, never reads the raw term.
    expect(source).not.toMatch(/search=\$\{encodeURIComponent\(search\)\}/);
    expect(source).not.toMatch(/buildQuery\(filters\)|buildOrderQuery\(filters, sort\)/);
  });
  it("the board's FilterBar export link is built from the page's query string", () => {
    expect(read("board-parts/FilterBar.tsx")).toContain("href={`/api/orders/export${queryString ? `?${queryString}` : \"\"}`}");
  });
});
