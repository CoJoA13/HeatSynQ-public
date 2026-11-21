import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_WORDS, CONTAINER_ROW, CONTAINER_TYPES_SHOT, DRAFT_SAVED_WORD, keyContainerRow, showContainerTypes,
  waitForDraftSaved, watchOfferedTypes,
} from "../e2e/lib/manual-capture-steps.mjs";
import { DraftSaveStatus } from "@/app/orders/new/EntryWorkspace";
import { tareEachText } from "@/lib/container-tare-prefill";

// The capture tool's three steps (e2e/lib/manual-capture-steps.mjs; the weights design's §14.2 and
// §15.2). No required check runs `npm run manual:capture`, and a step that failed there would cost
// a picture of the manual. So each branch is run here over a stand-in for a Playwright page, the
// way tests/e2e-order-totals.test.ts runs the totals reader. The stand-in keeps a record of every
// call made on it, in order, so a case holds what a step did and also what it did not do. One case
// holds the status word to what the app's status component renders. Only a run of the tool shows
// that the app's own boxes answer to these names, that one visible element of the real page has
// that word as its text, and that it holds through the two tab clicks.

/** One argument as the record spells it: a pattern as written, anything else as JSON. */
const spell = (args: unknown[]) =>
  args.map((arg) => (arg instanceof RegExp ? String(arg) : JSON.stringify(arg))).join(", ");

type Script = {
  /** Answers `{ value }` for a call that is to throw `value`, by the call as the record spells it. */
  fail?: (call: string) => { value: unknown } | undefined;
  /** What each read of a box's value answers, in turn. The last answer repeats. */
  values?: string[];
  /** What the armed wait for an answer settles with. Left out, the wait never settles. It is
   *  handed a way to put a line of its own into the record, and the time the wait was armed for. */
  answer?: (record: (line: string) => void, timeoutMs: number) => Promise<unknown>;
};

/** A stand-in for a page. `calls` is every call made on it or on a locator of its, in order.
 *  `predicates` is the test each armed wait was given. */
function standIn(script: Script = {}) {
  const calls: string[] = [];
  const predicates: ((response: unknown) => boolean)[] = [];
  let read = 0;
  const made = (call: string) => {
    calls.push(call);
    const thrown = script.fail?.(call);
    if (thrown) throw thrown.value;
  };
  const locator = (found: string): Record<string, unknown> => {
    const act = (method: string) => async (...args: unknown[]) => {
      made(`${found}.${method}(${spell(args)})`);
      if (method !== "inputValue") return undefined;
      const values = script.values ?? [""];
      return values[Math.min(read++, values.length - 1)];
    };
    const within = (how: string) => (...args: unknown[]) => locator(`${found}.${how}(${spell(args)})`);
    return {
      click: act("click"), fill: act("fill"), selectOption: act("selectOption"), inputValue: act("inputValue"),
      waitFor: act("waitFor"), type: act("type"), press: act("press"), pressSequentially: act("pressSequentially"),
      check: act("check"), first: within("first"), locator: within("locator"), getByRole: within("getByRole"),
      getByLabel: within("getByLabel"),
    };
  };
  const page = {
    getByRole: (...args: unknown[]) => locator(`getByRole(${spell(args)})`),
    getByLabel: (...args: unknown[]) => locator(`getByLabel(${spell(args)})`),
    getByText: (...args: unknown[]) => locator(`getByText(${spell(args)})`),
    waitForResponse: (predicate: (response: unknown) => boolean, options: { timeout: number }) => {
      predicates.push(predicate);
      made(`waitForResponse(${spell([options])})`);
      return (script.answer ?? (() => new Promise(() => {})))((line) => { calls.push(line); }, options.timeout);
    },
  };
  return { page, calls, predicates };
}

/** An answer the page saw, as far as the steps read one. */
const answer = (address: string, over: { method?: string; ok?: boolean; body?: unknown } = {}) => ({
  url: () => address,
  request: () => ({ method: () => over.method ?? "GET" }),
  ok: () => over.ok ?? true,
  json: async () => over.body,
});
/** What a wait or an action rejects with when its time runs out. */
const timedOut = (what: string) => Object.assign(new Error(`${what}: Timeout exceeded.`), { name: "TimeoutError" });

/** A step's answer beside the record of what it did on the page: one thing to hold, so a case
 *  cannot pass on half of it. */
const ran = async (step: Promise<unknown>, calls: string[]) => ({ answered: await step, calls });

/** Starts a step on a faked clock, runs that clock until no timer is left, and gives what the step
 *  resolved with. A wait the stand-in never satisfies then runs out at once, so a case fails on
 *  what the step answered and did, and not on its own time limit. */
const onFakedClock = async <T>(start: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers();
  const [resolved] = await Promise.all([start(), vi.runAllTimersAsync()]);
  return resolved;
};
afterEach(() => { vi.useRealTimers(); });

const STEEL = { id: "type-steel", name: "Steel Basket", active: true, tareEach: 42.5 };
const WIRE = { id: "type-wire", name: "Wire Basket", active: true, tareEach: null };

const ADD = 'getByRole("button", {"name":"Add container","exact":true}).click({"timeout":10000})';
const KEYS = [
  ADD,
  'getByLabel("Container 1 type", {"exact":true}).selectOption("type-steel", {"timeout":10000})',
  'getByLabel("Container 1 count", {"exact":true}).fill("3", {"timeout":10000})',
  'getByLabel("Container 1 pieces", {"exact":true}).fill("30", {"timeout":10000})',
];
const READ = 'getByLabel("Container 1 tare each", {"exact":true}).inputValue()';
const REMOVE = 'getByLabel("Container 1 type", {"exact":true})'
  + `.locator("xpath=ancestor::div[.//button[normalize-space()='Remove']][1]")`
  + '.getByRole("button", {"name":"Remove","exact":true}).click({"timeout":10000})';

describe("the capture report's words (e2e/lib/manual-capture-steps.mjs)", () => {
  it("holds each line word for word, the row's figures and the new picture's name", () => {
    expect(CAPTURE_WORDS).toEqual({
      filledWithRow: "Order entry with a customer, a part line and a container row filled in",
      keyed: "container row: 3 × Steel Basket, 30 pieces, Tare each as the type fills it",
      notOffered: "no container type named Steel Basket is offered on this screen, so no container row was keyed",
      noTareEach: "Steel Basket carries no Tare each on this database, so the row's Tare each box was left empty",
      containerTypes: "Pick lists with Container types chosen",
      noRows: "the Container types list showed no row within the wait, so the picture may show an empty table",
      takenOut: "the container row could not be keyed and was taken out again",
      notSeen: "the screen's read of its container types was not seen within the wait, so no container row was keyed",
      notTakenOut: "the container row could not be keyed and could not be taken out again, so the pictures may show it",
      notAdded: "Add container could not be pressed, so no container row was keyed",
      draftNotSaved: "the draft's status did not read Draft saved within the wait, so the pictures show the header as it stood",
    });
    expect(CONTAINER_ROW).toEqual({ typeName: "Steel Basket", count: "3", pieces: "30" });
    expect(CONTAINER_TYPES_SHOT).toBe("interaction-admin-reference-container-types");
  });

  it("says in the row's note what the row holds", () => {
    const { count, typeName, pieces } = CONTAINER_ROW;
    expect(CAPTURE_WORDS.keyed.startsWith(`container row: ${count} × ${typeName}, ${pieces} pieces, `)).toBe(true);
  });
});

describe("watchOfferedTypes", () => {
  it("arms one wait, for the time it is given, and takes only a good answer to the screen's own read", () => {
    const armed = standIn();
    watchOfferedTypes(armed.page, 1234);
    expect(armed.calls).toEqual(['waitForResponse({"timeout":1234})']);
    const [isRead] = armed.predicates;
    expect(isRead(answer("http://stand-in.invalid/api/picklists/containerType"))).toBe(true);
    expect(isRead(answer("http://stand-in.invalid/api/picklists/containerType", { method: "POST" }))).toBe(false);
    expect(isRead(answer("http://stand-in.invalid/api/picklists/containerType", { ok: false }))).toBe(false);
    expect(isRead(answer("http://stand-in.invalid/api/picklists/carrier"))).toBe(false);
    expect(isRead(answer("http://stand-in.invalid/api/admin/reference/containerType"))).toBe(false);
    expect(isRead(answer("not an address"))).toBe(false);

    const byDefault = standIn();
    watchOfferedTypes(byDefault.page);
    expect(byDefault.calls).toEqual(['waitForResponse({"timeout":15000})']);
  });

  it("resolves with the rows the screen read", async () => {
    const rows = [WIRE, STEEL];
    const { page } = standIn({ answer: async () => answer("http://stand-in.invalid/api/picklists/containerType", { body: rows }) });
    expect(await watchOfferedTypes(page)()).toEqual(rows);
  });

  it.each<[string, Script]>([
    ["no answer was seen in time", { answer: () => Promise.reject(timedOut("page.waitForResponse")) }],
    ["the answer could not be read", { answer: async () => ({ json: () => Promise.reject(new SyntaxError("Unexpected token")) }) }],
    ["the answer is not a list", { answer: async () => answer("http://stand-in.invalid/x", { body: { error: "Unknown pick list" } }) }],
    ["the wait could not be armed", { fail: () => ({ value: new Error("Target page has been closed") }) }],
  ])("resolves with null, and does not reject, when %s", async (_when, script) => {
    const { page } = standIn(script);
    expect(await watchOfferedTypes(page)()).toBeNull();
  });
});

describe("keyContainerRow", () => {
  /** The step, on a faked clock: its wait for the Tare each box is one a stand-in can leave
   *  unsatisfied. */
  const keyRow = (page: unknown, offered: unknown) => onFakedClock(() => keyContainerRow(page, offered));

  it("keys the row in order, types no Tare each, and waits until the box shows the type's figure as the screen spells it", async () => {
    const { page, calls } = standIn({ values: ["", "", tareEachText(STEEL.tareEach)] });
    expect(await ran(keyRow(page, [WIRE, STEEL]), calls))
      .toEqual({ answered: { keyed: true, notes: [CAPTURE_WORDS.keyed] }, calls: [...KEYS, READ, READ, READ] });
  });

  it("leaves the box alone for a type that carries no tare each, and says so", async () => {
    const { page, calls } = standIn();
    expect(await ran(keyRow(page, [{ ...STEEL, tareEach: null }]), calls))
      .toEqual({ answered: { keyed: true, notes: [CAPTURE_WORDS.noTareEach] }, calls: KEYS });
  });

  it("takes a tare each of 0 for a figure: it waits for the box and says the type filled it", async () => {
    const { page, calls } = standIn({ values: [tareEachText(0)] });
    expect(await ran(keyRow(page, [{ ...STEEL, tareEach: 0 }]), calls))
      .toEqual({ answered: { keyed: true, notes: [CAPTURE_WORDS.keyed] }, calls: [...KEYS, READ] });
  });

  it.each<[string, unknown[]]>([
    ["the list holds other types", [WIRE]],
    ["the list is empty", []],
  ])("adds no row and says the type is not offered when %s", async (_when, offered) => {
    const { page, calls } = standIn();
    expect(await ran(keyRow(page, offered), calls))
      .toEqual({ answered: { keyed: false, notes: [CAPTURE_WORDS.notOffered] }, calls: [] });
  });

  it("adds no row when the screen's read was not seen, and does not say the type is missing", async () => {
    const { page, calls } = standIn();
    expect(await ran(keyRow(page, null), calls))
      .toEqual({ answered: { keyed: false, notes: [CAPTURE_WORDS.notSeen] }, calls: [] });
  });

  it("says so when Add container could not be pressed, and presses no Remove", async () => {
    const { page, calls } = standIn({ fail: (call) => (call === ADD ? { value: timedOut("locator.click") } : undefined) });
    expect(await ran(keyRow(page, [STEEL]), calls)).toEqual({
      answered: { keyed: false, notes: [`${CAPTURE_WORDS.notAdded}: locator.click: Timeout exceeded.`] }, calls: [ADD],
    });
  });

  it.each([1, 2, 3])("takes the row out again, and says why, when key %i of the row fails", async (failing) => {
    const { page, calls } = standIn({ fail: (call) => (call === KEYS[failing] ? { value: new Error("boom") } : undefined) });
    expect(await ran(keyRow(page, [STEEL]), calls)).toEqual({
      answered: { keyed: false, notes: [`${CAPTURE_WORDS.takenOut}: boom`] }, calls: [...KEYS.slice(0, failing + 1), REMOVE],
    });
  });

  it("takes the row out again, and says what the box last showed, when the Tare each box never shows the type's figure", async () => {
    // The box stays empty, so the step's wait for the figure runs out on the faked clock. However
    // many times that wait read the box, nothing else was done between the keys and the Remove.
    const { page, calls } = standIn({ values: [""] });
    expect(await ran(keyRow(page, [STEEL]), calls)).toEqual({
      answered: { keyed: false, notes: [
        `${CAPTURE_WORDS.takenOut}: Timed out waiting for value ${JSON.stringify(tareEachText(STEEL.tareEach))} — last saw ""`,
      ] },
      calls: [...KEYS, ...Array<string>(calls.length - KEYS.length - 1).fill(READ), REMOVE],
    });
  });

  it("says the pictures may show the row when it could not be taken out again", async () => {
    const { page, calls } = standIn({ fail: (call) =>
      call === KEYS[2] ? { value: new Error("boom") } : call === REMOVE ? { value: timedOut("locator.click") } : undefined });
    expect(await ran(keyRow(page, [STEEL]), calls)).toEqual({
      answered: { keyed: false, notes: [`${CAPTURE_WORDS.notTakenOut}: boom`] }, calls: [...KEYS.slice(0, 3), REMOVE],
    });
  });

  it("resolves and never rejects, whatever a call on the page throws", async () => {
    for (const failing of [...KEYS, REMOVE]) {
      for (const value of [new Error("boom"), "a string", undefined, null]) {
        // A failed Remove is reached only after a failed key, so the key before it fails too.
        const { page } = standIn({ fail: (call) =>
          call === failing || (failing === REMOVE && call === KEYS[1]) ? { value } : undefined });
        expect(await keyRow(page, [STEEL])).toEqual({ keyed: false, notes: [expect.any(String)] });
      }
    }
  });

  it("says no row was added for a page that cannot even be asked for a control", async () => {
    const closed = () => { throw new Error("Target page has been closed"); };
    expect(await keyRow({ getByRole: closed, getByLabel: closed }, [STEEL]))
      .toEqual({ keyed: false, notes: [`${CAPTURE_WORDS.notAdded}: Target page has been closed`] });
  });
});

describe("showContainerTypes", () => {
  const PRESS = 'getByRole("button", {"name":"Container types","exact":true})';
  const BOX = String.raw`getByLabel(/^Tare each \(lb\) for /).first()`;
  const LIST_READ = "http://stand-in.invalid/api/admin/reference/containerType";
  const ANSWERED = "(the list's read answered)";
  /** As on the screen: the list is read only once its button is pressed, and answers a moment
   *  later. The record shows when. A wait armed for that read gives up when its own time runs out
   *  first, as a page's wait does. `over` is asked first whether a call is to throw. */
  const readOnPress = (over: NonNullable<Script["fail"]> = () => undefined): Script => {
    let pressed = () => {};
    let record: (line: string) => void = () => {};
    const read = new Promise((resolve) => {
      pressed = () => { setTimeout(() => { record(ANSWERED); resolve(answer(LIST_READ)); }, 20); };
    });
    return {
      answer: (toRecord, timeoutMs) => {
        record = toRecord;
        return new Promise((resolve, reject) => {
          const givesUp = setTimeout(() => { reject(timedOut("page.waitForResponse")); }, timeoutMs);
          void read.then((seen) => { clearTimeout(givesUp); resolve(seen); });
        });
      },
      fail: (call) => {
        const thrown = over(call);
        if (!thrown && call.startsWith(`${PRESS}.click(`)) pressed();
        return thrown;
      },
    };
  };

  it("arms the wait for the list's read, presses the list's button, waits for the read and then for a loaded row's box, and calls nothing else", async () => {
    const { page, calls, predicates } = standIn(readOnPress());
    expect(await ran(onFakedClock(() => showContainerTypes(page)), calls)).toEqual({ answered: { notes: [] }, calls: [
      'waitForResponse({"timeout":10000})',
      `${PRESS}.click({"timeout":10000})`,
      ANSWERED,
      `${BOX}.waitFor({"state":"visible","timeout":10000})`,
    ] });
    const [isRead] = predicates;
    expect(isRead(answer(LIST_READ))).toBe(true);
    expect(isRead(answer("http://stand-in.invalid/api/admin/reference/glAccount"))).toBe(false);
    expect(isRead(answer("http://stand-in.invalid/api/picklists/containerType"))).toBe(false);
  });

  it("still answers, with a note, when no row shows within the wait it is given", async () => {
    const { page, calls } = standIn(readOnPress((call) =>
      (call.startsWith(`${BOX}.waitFor(`) ? { value: timedOut("locator.waitFor") } : undefined)));
    expect(await ran(onFakedClock(() => showContainerTypes(page, 250)), calls)).toEqual({ answered: { notes: [CAPTURE_WORDS.noRows] }, calls: [
      'waitForResponse({"timeout":250})',
      `${PRESS}.click({"timeout":250})`,
      ANSWERED,
      `${BOX}.waitFor({"state":"visible","timeout":250})`,
    ] });
  });

  it("goes by the box and not by the read: a read that was not seen is no note and no failure", async () => {
    const { page } = standIn({ answer: () => Promise.reject(timedOut("page.waitForResponse")) });
    expect(await showContainerTypes(page)).toEqual({ notes: [] });
  });

  it("rejects when the list's button cannot be pressed, so the tool marks the picture's row", async () => {
    const { page } = standIn({ answer: () => Promise.reject(timedOut("page.waitForResponse")),
      fail: (call) => (call.startsWith(`${PRESS}.click(`) ? { value: timedOut("locator.click") } : undefined) });
    await expect(showContainerTypes(page)).rejects.toThrow("locator.click: Timeout exceeded.");
  });
});

describe("waitForDraftSaved", () => {
  const WAIT = 'getByText("Draft saved", {"exact":true}).waitFor({"state":"visible","timeout":10000})';
  /** The step, on the file's faked clock, so that a case fails on what the step answered and did,
   *  and not on its own time limit. */
  const waited = (page: unknown, timeoutMs?: number) => onFakedClock(() => waitForDraftSaved(page, timeoutMs));

  it("asks the page once, for the exact word to be visible within ten seconds, and answers that the draft is saved", async () => {
    const { page, calls } = standIn();
    expect(await ran(waited(page), calls)).toEqual({ answered: { saved: true, notes: [] }, calls: [WAIT] });
  });

  it("waits for the time it is given", async () => {
    const { page, calls } = standIn();
    expect(await ran(waited(page, 250), calls)).toEqual({ answered: { saved: true, notes: [] },
      calls: ['getByText("Draft saved", {"exact":true}).waitFor({"state":"visible","timeout":250})'] });
  });

  it("answers that the draft is not saved, with the report's one line, when the word does not show within the wait", async () => {
    const { page, calls } = standIn({ fail: (call) => (call === WAIT ? { value: timedOut("locator.waitFor") } : undefined) });
    expect(await ran(waited(page), calls))
      .toEqual({ answered: { saved: false, notes: [CAPTURE_WORDS.draftNotSaved] }, calls: [WAIT] });
  });

  it("answers and never rejects, whatever the page throws", async () => {
    for (const value of [new Error("boom"), "a string", undefined, null]) {
      const { page } = standIn({ fail: () => ({ value }) });
      expect(await waited(page)).toEqual({ saved: false, notes: [CAPTURE_WORDS.draftNotSaved] });
    }
  });

  it("answers the same for a page that cannot even be asked", async () => {
    const closed = () => { throw new Error("Target page has been closed"); };
    expect(await waited({ getByText: closed })).toEqual({ saved: false, notes: [CAPTURE_WORDS.draftNotSaved] });
  });

  it("waits for the word order entry's header shows once the draft is stored", () => {
    const status = renderToStaticMarkup(createElement(DraftSaveStatus, { state: { status: "saved", acknowledgedGeneration: 0 } }));
    expect(status.match(/^<span\b[^>]*>([^<]+)<\/span>$/)?.[1]).toBe(DRAFT_SAVED_WORD);
  });
});
