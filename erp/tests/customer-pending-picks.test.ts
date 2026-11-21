// #677: on the customer page a template picker's select and a surcharge's Opt out box show the
// operator's choice while its write and the re-read after it are out, where they used to snap back
// to the server's value until both had landed. The rule is src/lib/pending-pick.ts; the picker's
// row is src/lib/template-assignment-picker.ts's `buildPickerRow`.
//
// vitest has no DOM and the two sections show their rows only after their reads land, so the
// sections' own handlers are lifted out of their files' syntax trees and run over a hand-built
// environment (tests/helpers/source-lift.ts), with each request held until the test lets it go.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  shownValue, withPick, withoutSettledPick, type PendingPicks,
} from "../src/lib/pending-pick";
import { all, run } from "./helpers/source-lift";
import { jsxTags } from "./helpers/jsx-source";

describe("pending-pick", () => {
  it("a control shows its pick while one is out, the server's value otherwise", () => {
    expect(shownValue({ value: "t-2", seq: 1 }, "t-1")).toBe("t-2");
    expect(shownValue(undefined, "t-1")).toBe("t-1");
    expect(shownValue({ value: false, seq: 1 }, true)).toBe(false);
  });

  it("the settling of a pick's own write clears it", () => {
    const picks = withPick({}, "TRAVELER", "t-2", 1);
    expect(withoutSettledPick(picks, "TRAVELER", 1)).toEqual({});
  });

  it("an earlier write's settling leaves a later pick of the same key standing", () => {
    const picks = withPick(withPick({}, "TRAVELER", "t-2", 1), "TRAVELER", "t-3", 2);
    expect(withoutSettledPick(picks, "TRAVELER", 1)).toBe(picks);
    expect(withoutSettledPick(picks, "TRAVELER", 2)).toEqual({});
  });

  it("another key's pick is untouched", () => {
    const picks = withPick(withPick({}, "TRAVELER", "t-2", 1), "SHIPPER", "s-2", 2);
    expect(withoutSettledPick(picks, "TRAVELER", 1)).toEqual({ SHIPPER: { value: "s-2", seq: 2 } });
  });
});

// ---- the sections' own handlers ----

function parse(relative: string): ts.SourceFile {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function functionText(source: ts.SourceFile, name: string): string {
  const found = all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === name);
  expect(found).toHaveLength(1);
  return found[0].getText(source);
}
/** Every promise reaction queued so far has run. */
const flush = () => new Promise<void>((done) => setImmediate(done));

/** A request the test answers by hand. */
function held<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A state cell fed by updaters, as React's setter is. */
function cell<T>(initial: T) {
  const box = { value: initial };
  const set = (u: T | ((prev: T) => T)) => { box.value = typeof u === "function" ? (u as (prev: T) => T)(box.value) : u; };
  return { box, set };
}

describe("TemplateAssignmentsSection: a pick shows while its write and re-read are out", () => {
  function section() {
    const source = parse("../src/app/customers/[id]/TemplateAssignmentsSection.tsx");
    const writes: { url: string; method: string; answer: ReturnType<typeof held> }[] = [];
    const reads: ReturnType<typeof held>[] = [];
    const picks = cell<PendingPicks<string>>({});
    const errors: (string | null)[] = [];
    const env: Record<string, unknown> = {
      saveQueue: { current: Promise.resolve() },
      pickSeq: { current: 0 },
      setPicks: picks.set,
      withPick, withoutSettledPick,
      customerId: "c-1",
      invalidateHistory: () => {},
      onError: (m: string | null) => { errors.push(m); },
      loadResolved: () => { const r = held(); reads.push(r); return r.promise; },
      api: (url: string, init: { method: string }) => { const answer = held(); writes.push({ url, method: init.method, answer }); return answer.promise; },
    };
    env.run = run(functionText(source, "run"), env);
    const onPick = run<(docType: string, hasOwn: boolean, value: string) => void>(functionText(source, "onPick"), env);
    return { onPick, writes, reads, picks, errors };
  }

  it("a pick shows at once, and gives way once its write and the re-read after it land", async () => {
    const s = section();
    s.onPick("TRAVELER", false, "t-2");
    expect(s.picks.box.value.TRAVELER?.value).toBe("t-2");
    await flush();
    expect(s.writes.map((w) => w.method)).toEqual(["PUT"]);
    s.writes[0].answer.resolve({});
    await flush();
    expect(s.picks.box.value.TRAVELER?.value).toBe("t-2"); // the re-read is still out
    s.reads[0].resolve([]);
    await flush();
    expect(s.picks.box.value).toEqual({});
  });

  it("an earlier write's re-read does not clear a later pick of the same row", async () => {
    const s = section();
    s.onPick("TRAVELER", false, "t-2");
    s.onPick("TRAVELER", true, "t-3");
    await flush();
    s.writes[0].answer.resolve({});
    await flush();
    s.reads[0].resolve([]);
    await flush();
    expect(s.picks.box.value.TRAVELER?.value).toBe("t-3");
    s.writes[1].answer.resolve({});
    await flush();
    s.reads[1].resolve([]);
    await flush();
    expect(s.picks.box.value).toEqual({});
  });

  it("a refused write gives way after its rollback read, and after that read failing too", async () => {
    const s = section();
    s.onPick("TRAVELER", false, "t-2");
    await flush();
    s.writes[0].answer.reject(new Error("Refused."));
    await flush();
    expect(s.picks.box.value.TRAVELER?.value).toBe("t-2");
    s.reads[0].reject(new Error("Offline."));
    await flush();
    expect(s.picks.box.value).toEqual({});
    expect(s.errors).toEqual(["Refused."]);
  });

  it("Use default / inherit clears a pick still out (the row as shown holds it), and does nothing on a row with no assignment", async () => {
    const s = section();
    s.onPick("TRAVELER", false, "");
    expect(s.picks.box.value).toEqual({});
    await flush();
    expect(s.writes).toEqual([]);
    s.onPick("TRAVELER", true, "");
    expect(s.picks.box.value.TRAVELER?.value).toBe("");
    await flush();
    expect(s.writes.map((w) => w.method)).toEqual(["DELETE"]);
  });

  it("the select is built from the row's pick", () => {
    const tags = jsxTags("src/app/customers/[id]/TemplateAssignmentsSection.tsx");
    const select = tags.filter((t) => t.name === "select");
    expect(select).toHaveLength(1);
    expect(select[0].attr("value")).toBe("row.selectedTemplateId");
    expect(select[0].attr("onChange")).toBe("(e) => onPick(docType, row.hasOwnAssignment, e.target.value)");
    const source = parse("../src/app/customers/[id]/TemplateAssignmentsSection.tsx");
    const builds = all(source, ts.isCallExpression).filter((c) => ts.isIdentifier(c.expression) && c.expression.text === "buildPickerRow");
    expect(builds.map((c) => c.getText(source))).toEqual(["buildPickerRow(display, names, picks[docType]?.value)"]);
  });
});

describe("SurchargeOverridesSection: an Opt out click shows while its save is out", () => {
  function section() {
    const source = parse("../src/app/customers/[id]/SurchargeOverridesSection.tsx");
    const saves: { id: string; patch: unknown; answer: ReturnType<typeof held<boolean>> }[] = [];
    const picks = cell<PendingPicks<boolean>>({});
    const env: Record<string, unknown> = {
      optOutSeq: { current: 0 },
      setOptOutPicks: picks.set,
      withPick, withoutSettledPick,
      save: (id: string, patch: unknown) => { const answer = held<boolean>(); saves.push({ id, patch, answer }); return answer.promise; },
    };
    const pickOptOut = run<(id: string, optOut: boolean) => void>(functionText(source, "pickOptOut"), env);
    return { pickOptOut, saves, picks };
  }

  it("the click shows at once, and gives way when its save settles, landed or not", async () => {
    const s = section();
    s.pickOptOut("s-1", true);
    expect(s.picks.box.value["s-1"]?.value).toBe(true);
    expect(s.saves.map((x) => x.patch)).toEqual([{ optOut: true }]);
    s.saves[0].answer.resolve(false);
    await flush();
    expect(s.picks.box.value).toEqual({});
  });

  it("an earlier save's settling leaves a later click standing", async () => {
    const s = section();
    s.pickOptOut("s-1", true);
    s.pickOptOut("s-1", false);
    s.saves[0].answer.resolve(true);
    await flush();
    expect(s.picks.box.value["s-1"]?.value).toBe(false);
    s.saves[1].answer.resolve(true);
    await flush();
    expect(s.picks.box.value).toEqual({});
  });

  it("the box shows the pick and sends through pickOptOut", () => {
    const boxes = jsxTags("src/app/customers/[id]/SurchargeOverridesSection.tsx")
      .filter((t) => t.name === "input" && t.attr("type") === "checkbox");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].attr("checked")).toBe("shownValue(optOutPicks[row.surchargeId], row.optOut)");
    expect(boxes[0].attr("onChange")).toBe("(e) => pickOptOut(row.surchargeId, e.target.checked)");
  });
});
