import { describe, expect, it, vi } from "vitest";
import { callback, source } from "./helpers/lift-callback";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { adoptTitle } from "../src/app/admin/users/title-cell";
import { caughtUp } from "../src/lib/settings-landed";
import { enterBox, focusRecord, heldText, leaveBox, noteFocus, type BoxCommit } from "../src/lib/focus-record";

// Owner ruling R7, P8 step 5: the commits of the blur-save boxes outside the edit guard, lifted from
// their pages. A commit that refuses the text answers `false` (the box is back on what it held and
// nothing was sent), so an Enter keeps the box's record of its text at focus and the blur after it
// sends nothing; one that sends answers the text the box shows once its save lands, or `false` when
// it does not land, and marks the box Saved only when it lands. The decision these answers feed is
// src/lib/focus-record.ts (tests/focus-record.test.ts); tests/enter-commit-census.test.ts holds every
// box to its Enter.

const tick = () => new Promise((res) => setTimeout(res, 0));

describe("Part fields: Name and Sort", () => {
  const PAGE = "app/admin/part-fields/page.tsx";
  function lift(landed = true) {
    const save = vi.fn(async () => landed); const load = vi.fn(async () => undefined);
    const setError = vi.fn(); const clearDraft = vi.fn(); const savedMarks = { mark: vi.fn() };
    const dropSettledDraft = vi.fn();
    const saveBox = callback<(key: string, id: string, body: object, shown: string, sent: string) => Promise<string | false>>(
      PAGE, "PartFieldsPage", "saveBox", { save, savedMarks, dropSettledDraft });
    const putBack = vi.fn();
    const env = { load, setError, clearDraft, putBack, saveBox };
    const name = callback<(id: string) => (value: string) => false | Promise<string | false>>(PAGE, "PartFieldsPage", "commitName", env);
    const sort = callback<(id: string) => (value: string) => false | Promise<string | false>>(PAGE, "PartFieldsPage", "commitSort", env);
    return { name, sort, save, setError, clearDraft, putBack, dropSettledDraft, savedMarks };
  }
  it("a blank Name is refused: false, the box put back, nothing sent", () => {
    const r = lift();
    expect(r.name("f1")("  ")).toBe(false);
    expect(r.setError).toHaveBeenCalledWith("Name is required");
    expect(r.putBack).toHaveBeenCalledWith("f1.name");
    expect(r.save).not.toHaveBeenCalled();
  });
  it("a Name that lands answers its trimmed text and marks the box", async () => {
    const r = lift();
    await expect(r.name("f1")(" Alloy ")).resolves.toBe("Alloy");
    expect(r.save).toHaveBeenCalledWith("f1", { name: "Alloy" });
    expect(r.savedMarks.mark).toHaveBeenCalledWith("f1.name", "Alloy");
    // The draft is the newest save's to drop, through the page's leaveSave or enterSave, never the commit's.
    expect(r.dropSettledDraft).not.toHaveBeenCalled();
    expect(r.clearDraft).not.toHaveBeenCalled();
  });
  it("a Name that does not land answers false and marks nothing", async () => {
    const r = lift(false);
    await expect(r.name("f1")("Alloy")).resolves.toBe(false);
    expect(r.savedMarks.mark).not.toHaveBeenCalled();
  });
  it("a Sort that is not a whole number of 0 or more is refused: false, nothing sent", () => {
    const r = lift();
    for (const typed of ["", "-1", "1.5", "x"]) expect(r.sort("f1")(typed)).toBe(false);
    expect(r.save).not.toHaveBeenCalled();
  });
  it("a Sort that lands answers the figure the box shows", async () => {
    const r = lift();
    await expect(r.sort("f1")("07")).resolves.toBe("7");
    expect(r.save).toHaveBeenCalledWith("f1", { sort: 7 });
  });
});

describe("Surcharges: Name and Position", () => {
  const PAGE = "app/admin/surcharges/page.tsx";
  function lift(landed = true) {
    const save = vi.fn(async () => landed); const load = vi.fn(async () => undefined);
    const setError = vi.fn(); const clearDraft = vi.fn(); const savedMarks = { mark: vi.fn() };
    const saveBox = callback<(key: string, saved: Promise<boolean>, shown: string) => Promise<string | false>>(
      PAGE, "SurchargesPage", "saveBox", { savedMarks });
    const dropSettledDraft = vi.fn();
    const env = { save, load, setError, clearDraft, putBack: vi.fn(), dropSettledDraft, saveBox };
    const name = callback<(id: string, value: string) => false | Promise<string | false>>(PAGE, "SurchargesPage", "commitName", env);
    const position = callback<(id: string, value: string) => false | Promise<string | false>>(PAGE, "SurchargesPage", "commitPosition", env);
    return { name, position, save, setError, savedMarks, clearDraft, dropSettledDraft };
  }
  it("a blank Name and a Position that is not a number are refused: false, nothing sent", () => {
    const r = lift();
    expect(r.name("s1", " ")).toBe(false);
    expect(r.position("s1", "")).toBe(false);
    expect(r.position("s1", "x")).toBe(false);
    expect(r.save).not.toHaveBeenCalled();
  });
  it("a Name and a Position that land answer what the box shows and mark it", async () => {
    const r = lift();
    await expect(r.name("s1", " Energy ")).resolves.toBe("Energy");
    await expect(r.position("s1", "3")).resolves.toBe("3");
    expect(r.savedMarks.mark.mock.calls).toEqual([["s1.name", "Energy", { decimal: false }], ["s1.position", "3", { decimal: false }]]);
    expect(r.dropSettledDraft).not.toHaveBeenCalled();
    expect(r.clearDraft).not.toHaveBeenCalled();
  });
  it("a save that does not land answers false and marks nothing", async () => {
    const r = lift(false);
    await expect(r.name("s1", "Energy")).resolves.toBe(false);
    expect(r.savedMarks.mark).not.toHaveBeenCalled();
  });
});

describe("Step codes: a suggested parameter's Name", () => {
  const PAGE = "app/admin/step-codes/page.tsx";
  function lift(landed = true) {
    const enqueueFieldOp = vi.fn(async () => landed); const load = vi.fn(async () => undefined);
    const setError = vi.fn(); const clearDraft = vi.fn(); const savedMarks = { mark: vi.fn() };
    const dropSettledDraft = vi.fn();
    const commit = callback<(codeId: string, fieldId: string, value: string) => false | Promise<string | false>>(
      PAGE, "StepCodesPage", "commitLabel", {
        enqueueFieldOp, load, setError, clearDraft, putBack: vi.fn(), savedMarks, dropSettledDraft,
        fieldLabelDraftKey: (c: string, f: string) => `${c}:${f}`, relabelFieldById: vi.fn(),
      });
    return { commit, enqueueFieldOp, setError, savedMarks, clearDraft, dropSettledDraft };
  }
  it("a blank name is refused: false, nothing sent", () => {
    const r = lift();
    expect(r.commit("c1", "f1", " ")).toBe(false);
    expect(r.setError).toHaveBeenCalledWith("Parameter name is required");
    expect(r.enqueueFieldOp).not.toHaveBeenCalled();
  });
  it("a name that lands answers its trimmed text and marks the box; one that does not answers false", async () => {
    const r = lift();
    await expect(r.commit("c1", "f1", " Temp ")).resolves.toBe("Temp");
    expect(r.savedMarks.mark).toHaveBeenCalledWith("c1:f1", "Temp");
    expect(r.dropSettledDraft).not.toHaveBeenCalled();
    expect(r.clearDraft).not.toHaveBeenCalled();
    const lost = lift(false);
    await expect(lost.commit("c1", "f1", "Temp")).resolves.toBe(false);
    expect(lost.savedMarks.mark).not.toHaveBeenCalled();
  });
});

describe("Settings: a single-line box", () => {
  const PAGE = "app/admin/settings/page.tsx";
  it("a blank number is refused before any request, and the commit answers false once it settles", async () => {
    const api = vi.fn(async () => ({})); const setError = vi.fn(); const load = vi.fn();
    const save = callback<(row: unknown, raw: string) => Promise<boolean>>(PAGE, "SettingsPage", "save", {
      api, setError, load, widgetKindFor: () => "number", coerceForSubmit: (_k: string, v: string) => v,
      invalidateSetupBanner: vi.fn(), savedMarks: { mark: vi.fn() },
    });
    const landed = { current: {} as Record<string, { text: string; attempt: number }> };
    const commit = callback<(row: unknown) => (value: string) => Promise<string | false>>(PAGE, "SettingsPage", "commitSetting",
      { save, landed, newest: { current: {} }, attempts: { current: 0 } });
    await expect(commit({ key: "k", value: 3 })(" ")).resolves.toBe(false);
    expect(landed.current).toEqual({});
    expect(api).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith("Enter a value");
  });
  it("a value that lands answers the typed text and marks the box; one refused by the server answers false", async () => {
    const savedMarks = { mark: vi.fn() };
    const api = vi.fn(async () => ({}));
    const env = { api, setError: vi.fn(), load: vi.fn(), widgetKindFor: () => "text", coerceForSubmit: (_k: string, v: string) => v,
      invalidateSetupBanner: vi.fn(), savedMarks };
    const save = callback<(row: unknown, raw: string) => Promise<boolean>>(PAGE, "SettingsPage", "save", env);
    const landed = { current: {} as Record<string, { text: string; attempt: number }> };
    const commit = callback<(row: unknown) => (value: string) => Promise<string | false>>(PAGE, "SettingsPage", "commitSetting",
      { save, landed, newest: { current: {} }, attempts: { current: 0 } });
    await expect(commit({ key: "company_name", value: "A" })("B")).resolves.toBe("B");
    expect(savedMarks.mark).toHaveBeenCalledWith("company_name", "B");
    expect(landed.current).toEqual({ company_name: { text: "B", attempt: 1 } });
    api.mockImplementationOnce(async () => { throw new Error("refused"); });
    await expect(commit({ key: "company_name", value: "A" })("C")).resolves.toBe(false);
    expect(savedMarks.mark).toHaveBeenCalledTimes(1);
    // A refused write leaves the stored text as it was, so re-entering the box takes that as its
    // text at focus and the unsaved text is sent again (Codex on #812).
    expect(landed.current).toEqual({ company_name: { text: "B", attempt: 1 } });
    await tick();
  });
  it("an older write of the box answering last stands in for nothing (Codex on #812)", async () => {
    const answers: ((ok: boolean) => void)[] = [];
    const save = vi.fn(() => new Promise<boolean>((res) => { answers.push(res); }));
    const landed = { current: {} as Record<string, { text: string; attempt: number }> };
    const newest = { current: {} as Record<string, number> };
    const commit = callback<(row: unknown) => (value: string) => Promise<string | false>>(PAGE, "SettingsPage", "commitSetting",
      { save, landed, newest, attempts: { current: 0 } });
    const row = { key: "company_phone", value: "A" };
    const b = commit(row)("B"); const c = commit(row)("C");
    answers[1](true); await c;
    // C's read lands and its row holds C, so C's entry goes; B answers after it.
    landed.current = caughtUp(landed.current, [{ key: "company_phone", value: "C" }]);
    answers[0](true); await b;
    expect(landed.current).toEqual({});
  });
  it("another box's save and read do not discard a box's landed write (Codex on #812)", async () => {
    const answers: ((ok: boolean) => void)[] = [];
    const save = vi.fn(() => new Promise<boolean>((res) => { answers.push(res); }));
    const landed = { current: {} as Record<string, { text: string; attempt: number }> };
    const commit = callback<(row: unknown) => (value: string) => Promise<string | false>>(PAGE, "SettingsPage", "commitSetting",
      { save, landed, newest: { current: {} }, attempts: { current: 0 } });
    const phone = commit({ key: "company_phone", value: "A" })("B");
    const name = commit({ key: "company_name", value: "X" })("Y");
    answers[1](true); await name;
    // The name's read lands before the phone's write commits: it still shows the phone as A.
    landed.current = caughtUp(landed.current, [{ key: "company_phone", value: "A" }, { key: "company_name", value: "Y" }]);
    answers[0](true); await phone;
    expect(landed.current.company_phone?.text).toBe("B");
  });
});

describe("Users: the text cell", () => {
  it("a title that lands answers the typed text; one that does not answers false", async () => {
    const onSave = vi.fn(async () => true);
    const landed = { current: null as { text: string; attempt: number } | null };
    const attempts = { current: 0 };
    const commit = callback<(value: string) => Promise<string | false>>("app/admin/users/page.tsx", "TextCell", "commit", { onSave, landed, attempts });
    await expect(commit("Quality")).resolves.toBe("Quality");
    expect(landed.current?.text).toBe("Quality");
    onSave.mockImplementationOnce(async () => false);
    await expect(commit("QA")).resolves.toBe(false);
    // A refused save leaves the stored title as it was (Codex on #812).
    expect(landed.current?.text).toBe("Quality");
  });
  it("an older save finishing last does not replace a newer landed title (Codex on #812)", async () => {
    let finishB!: (ok: boolean) => void;
    const onSave = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((res) => { finishB = res; }))
      .mockImplementationOnce(async () => true);
    const landed = { current: null as { text: string; attempt: number } | null };
    const attempts = { current: 0 };
    const commit = callback<(value: string) => Promise<string | false>>("app/admin/users/page.tsx", "TextCell", "commit", { onSave, landed, attempts });
    const b = commit("B");
    await commit("C");
    finishB(true); await b;
    expect(landed.current?.text).toBe("C");
  });
});

// Each queued save answers whether its write landed; the commits above read that answer, and a
// save that reported a refused write as landed would mark the box Saved and keep the sent text as
// its record, so leaving it would send the stored figure back.
describe("the queued saves answer whether the write landed", () => {
  const refused = () => vi.fn(async () => { throw new Error("refused"); });
  it("Surcharges", async () => {
    const env = { rowsRef: { current: [{ id: "s1" }] }, buildBody: () => ({}), setBlocked: vi.fn(), invalidateHistory: vi.fn(),
      setError: vi.fn(), load: vi.fn(async () => undefined), saveQueue: { current: Promise.resolve() } };
    const ok = callback<(id: string, patch: object) => Promise<boolean>>("app/admin/surcharges/page.tsx", "SurchargesPage", "save", { ...env, api: vi.fn(async () => ({})) });
    await expect(ok("s1", {})).resolves.toBe(true);
    const no = callback<(id: string, patch: object) => Promise<boolean>>("app/admin/surcharges/page.tsx", "SurchargesPage", "save", { ...env, api: refused() });
    await expect(no("s1", {})).resolves.toBe(false);
  });
  it("Surcharge overrides", async () => {
    const env = { rowsRef: { current: [{ surchargeId: "s1" }] }, buildBody: () => ({}), customerId: "c1", invalidateHistory: vi.fn(),
      onError: vi.fn(), load: vi.fn(async () => undefined), saveQueue: { current: Promise.resolve() } };
    const PAGE = "app/customers/[id]/SurchargeOverridesSection.tsx";
    const ok = callback<(id: string, patch: object) => Promise<boolean>>(PAGE, "SurchargeOverridesSection", "save", { ...env, api: vi.fn(async () => ({})) });
    await expect(ok("s1", {})).resolves.toBe(true);
    const no = callback<(id: string, patch: object) => Promise<boolean>>(PAGE, "SurchargeOverridesSection", "save", { ...env, api: refused() });
    await expect(no("s1", {})).resolves.toBe(false);
  });
  it("Step codes", async () => {
    const env = { invalidateHistory: vi.fn(), setError: vi.fn(), setBlocked: vi.fn(), load: vi.fn(async () => undefined),
      saveQueue: { current: Promise.resolve() } };
    const PAGE = "app/admin/step-codes/page.tsx";
    const ok = callback<(id: string, build: object) => Promise<boolean>>(PAGE, "StepCodesPage", "save", { ...env, api: vi.fn(async () => ({})) });
    await expect(ok("c1", { body: {} })).resolves.toBe(true);
    const no = callback<(id: string, build: object) => Promise<boolean>>(PAGE, "StepCodesPage", "save", { ...env, api: refused() });
    await expect(no("c1", { body: {} })).resolves.toBe(false);
  });
  it("Part fields", async () => {
    const env = { setError: vi.fn(), setBlocked: vi.fn(), load: vi.fn(async () => undefined), rows: [], ApiError: class {}, invalidateHistory: vi.fn() };
    const PAGE = "app/admin/part-fields/page.tsx";
    const ok = callback<(id: string, body: object) => Promise<boolean>>(PAGE, "PartFieldsPage", "save", { ...env, api: vi.fn(async () => ({})) });
    await expect(ok("f1", {})).resolves.toBe(true);
    const no = callback<(id: string, body: object) => Promise<boolean>>(PAGE, "PartFieldsPage", "save", { ...env, api: refused() });
    await expect(no("f1", {})).resolves.toBe(false);
  });
});

// Codex on #812: the cell was keyed by the user's title, so the reload after an Enter remounted it
// and took the cursor out of the box, dropping anything typed while the save was out.
describe("Users: the text cell keeps its identity across reloads", () => {
  it("is keyed by the user alone", () => {
    const page = readFileSync(new URL("../src/app/admin/users/page.tsx", import.meta.url), "utf8");
    expect(page).toContain('<TextCell key={u.id} user={u} field="title"');
    expect(page).toContain('<TextCell key={u.id} user={u} field="displayName"');
    expect(page).not.toMatch(/<TextCell key=\{`/);
  });
  it("notes its stored title on focus, not the text it shows, so a refused save is sent again", () => {
    const page = readFileSync(new URL("../src/app/admin/users/page.tsx", import.meta.url), "utf8");
    expect(page).toContain("onFocus={() => noteFocus(focus.current, field, landed.current?.text ?? stored)}");
    // A reload is the newest stored title known: a save sent before it that finishes later is older.
    expect(page).toContain("landed.current = { text: stored, attempt: attempts.current };");
    expect(page).not.toContain("noteFocus(focus.current, field, e.target.value)");
  });
  it("adopts a reloaded title unless the box is being edited and holds text typed since its record", () => {
    expect(adoptTitle("Quality", "Quality", true, "Quality", false)).toBe("Quality");
    expect(adoptTitle("QualityX", "Quality", true, "Quality", false)).toBe("QualityX");
    expect(adoptTitle("Old", "New", true, "Old", false)).toBe("New");
    expect(adoptTitle("typed", "New", false, "Old", false)).toBe("New");
    expect(adoptTitle("typed", "New", true, null, false)).toBe("New");
  });
  it("adopts no reloaded title while a save of the box is out: B's reload must not replace a pending C", () => {
    expect(adoptTitle("C", "B", true, "C", true)).toBe("C");
    expect(adoptTitle("C", "B", false, "C", true)).toBe("C");
  });
  it("asks whether a save of the box is out", () => {
    const page = readFileSync(new URL("../src/app/admin/users/page.tsx", import.meta.url), "utf8");
    expect(page).toContain("adoptTitle(el.value, stored, editing, recorded, Object.hasOwn(focus.current.held, field))");
  });
});

describe("Settings: a box's text at focus is what it last stored, not what it shows", () => {
  const page = readFileSync(new URL("../src/app/admin/settings/page.tsx", import.meta.url), "utf8");
  it("every Settings box notes its stored text on focus", () => {
    expect(page.match(/onFocus=\{\(\) => noteFocus\(focus\.current, r\.key, storedText\(r\)\)\}/g)).toHaveLength(2);
    expect(page).not.toContain("noteFocus(focus.current, r.key, e.target.value)");
  });
  it("the stored text is the newest landed write until the rows are read again", () => {
    expect(page).toContain("if (latest.isCurrent(t)) { landed.current = caughtUp(landed.current, r); setRows(r); }");
  });
});

// Codex on #812: a refusal while a save of the box is out put the row's figure back, which could
// still be the one from before that save, and leaving the box then sent it.
describe("a refusal puts back the text a pending save sent", () => {
  const PAGES: [string, string][] = [
    ["app/admin/part-fields/page.tsx", "PartFieldsPage"],
    ["app/admin/surcharges/page.tsx", "SurchargesPage"],
    ["app/admin/step-codes/page.tsx", "StepCodesPage"],
    ["app/customers/[id]/SurchargeOverridesSection.tsx", "SurchargeOverridesSection"],
  ];
  for (const [path, owner] of PAGES) {
    it(`${owner}: the box gets the held text while a save is out, else its draft is dropped`, () => {
      const rec = focusRecord(); noteFocus(rec, "k", "A");
      let drafts: Record<string, string> = { k: "" };
      const setTextDrafts = (u: (d: Record<string, string>) => Record<string, string>) => { drafts = u(drafts); };
      const clearDraft = (key: string) => setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
      const putBack = callback<(key: string) => void>(path, owner, "putBack", { focus: { current: rec }, heldText, clearDraft, setTextDrafts });
      putBack("k");
      expect(drafts).toEqual({});
      drafts = { k: "" };
      enterBox({ key: "Enter", preventDefault: () => {} }, rec, "k", "B", () => new Promise(() => {}));
      putBack("k");
      expect(drafts).toEqual({ k: "B" });
    });
  }
});

describe("every refusal in these commits puts the box back through putBack, never by dropping its draft", () => {
  const COMMITS: [string, string, string[]][] = [
    ["app/admin/part-fields/page.tsx", "PartFieldsPage", ["commitName", "commitSort"]],
    ["app/admin/surcharges/page.tsx", "SurchargesPage", ["commitName", "commitPosition", "commitSurchargeBox"]],
    ["app/admin/step-codes/page.tsx", "StepCodesPage", ["commitLabel"]],
    ["app/customers/[id]/SurchargeOverridesSection.tsx", "SurchargeOverridesSection", ["commitRateOverride", "commitAmountOverride"]],
  ];
  for (const [path, owner, names] of COMMITS) {
    for (const name of names) {
      it(`${owner}.${name}`, () => {
        const file = source(path);
        let fn: ts.FunctionDeclaration | undefined;
        const walk = (n: ts.Node): void => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) fn = n; ts.forEachChild(n, walk); };
        walk(file);
        expect(fn, `${owner}.${name}`).toBeDefined();
        const calls: string[] = [];
        const look = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push(n.expression.text);
          ts.forEachChild(n, look);
        };
        look(fn!);
        expect(calls).toContain("putBack");
        expect(calls).not.toContain("clearDraft");
      });
    }
  }
});

// Codex on #812: a settled save dropped its box's draft by text alone, so an earlier save of the same
// text (B, C, then B again) cleared the newest one's draft. The draft is now dropped only when the
// newest save of the box settles: each page's leaveSave and enterSave hand that to the record.
describe("a box's draft is dropped when its newest save settles, never an older one", () => {
  const PAGES: [string, string][] = [
    ["app/admin/part-fields/page.tsx", "PartFieldsPage"],
    ["app/admin/surcharges/page.tsx", "SurchargesPage"],
    ["app/admin/step-codes/page.tsx", "StepCodesPage"],
    ["app/customers/[id]/SurchargeOverridesSection.tsx", "SurchargeOverridesSection"],
  ];
  for (const [path, owner] of PAGES) {
    it(owner, async () => {
      const rec = focusRecord(); noteFocus(rec, "k", "A");
      const dropSettledDraft = vi.fn(); const clearDraft = vi.fn();
      const env = { focus: { current: rec }, leaveBox, enterBox, dropSettledDraft, clearDraft, sameSentValue: (a: string, b: string) => a === b };
      const enterSave = callback<(e: unknown, key: string, commit: BoxCommit) => void>(path, owner, "enterSave", env);
      const answers: ((shown: string | false) => void)[] = [];
      const commit: BoxCommit = () => new Promise((res) => { answers.push(res); });
      const enter = (value: string) => enterSave({ key: "Enter", currentTarget: { value }, preventDefault: () => {} }, "k", commit);
      enter("B"); enter("C"); enter("B");
      answers[0]("B"); await tick();
      answers[1]("C"); await tick();
      expect(dropSettledDraft).not.toHaveBeenCalled();
      answers[2]("B"); await tick();
      expect(dropSettledDraft.mock.calls).toEqual([["k", "B"]]);
    });
  }
});

describe("caughtUp (Settings' landed writes)", () => {
  it("drops an entry once its row holds its text, and keeps one the rows do not reflect", () => {
    const landed = { a: { text: "B", attempt: 1 }, b: { text: "Y", attempt: 2 } };
    expect(caughtUp(landed, [{ key: "a", value: "B" }, { key: "b", value: "X" }])).toEqual({ b: { text: "Y", attempt: 2 } });
  });
});
