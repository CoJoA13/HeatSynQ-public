// A part's Each weight and Load weight (blur-saved on the part page) and New part's Each weight
// (#517 pull request 5c): each is read by the one rule before anything is sent, a refused box is
// named, and the part page's boxes go back to the figure held at focus. Each case runs the function
// the component itself declares (helpers/lift-callback).
import { describe, expect, it, vi } from "vitest";
import { decimalRefusal } from "../src/lib/decimal-entry";
import { EACH_WEIGHT, INSPECTION_MAX, INSPECTION_MIN, LOAD_WEIGHT } from "../src/lib/part-boxes";
import { wholeNumberRefusal, readWholeNumber } from "../src/lib/whole-number-entry";
import { LOAD_QTY, REQUEST_DAYS_OVERRIDE } from "../src/lib/whole-number-boxes";
import { callback } from "./helpers/lift-callback";
import { oneShotHold } from "../src/lib/single-flight";
import { enterBox, focusRecord, leaveBox, noteFocus, type BoxCommit } from "../src/lib/focus-record";

function identity(name: "commitEachWeight" | "commitLoadWeight") {
  const save = vi.fn(async () => true); const patchDraft = vi.fn(); const onError = vi.fn();
  const commit = callback<(v: string, atFocus: string) => void>("app/parts/[id]/IdentitySection.tsx", "IdentitySection", name, {
    save, patchDraft, onError, decimalRefusal, EACH_WEIGHT, LOAD_WEIGHT,
  });
  return { commit, save, patchDraft, onError };
}

describe("IdentitySection: Each weight", () => {
  it("too many digits after the point is named and the box goes back to what it held at focus", () => {
    const r = identity("commitEachWeight"); r.commit("1.23456", "2.5");
    expect(r.patchDraft.mock.calls).toEqual([[{ eachWeight: "2.5" }]]);
    expect(r.onError.mock.calls).toEqual([["Each weight (lb): use at most 4 digits after the point."]]);
    expect(r.save).not.toHaveBeenCalled();
  });
  it("a blank is refused too: Each weight is required", () => {
    const r = identity("commitEachWeight"); r.commit("", "2.5");
    expect(r.patchDraft.mock.calls).toEqual([[{ eachWeight: "2.5" }]]);
    expect(r.onError.mock.calls).toEqual([["Each weight (lb): must be greater than zero."]]);
    expect(r.save).not.toHaveBeenCalled();
  });
  it("a fitting figure is sent as typed", () => {
    const r = identity("commitEachWeight"); r.commit(".36", "2.5");
    expect(r.save.mock.calls).toEqual([[{ eachWeight: ".36" }]]);
    expect(r.patchDraft).not.toHaveBeenCalled(); expect(r.onError).not.toHaveBeenCalled();
  });
});

describe("IdentitySection: Load weight", () => {
  it("zero is named and the box goes back to what it held at focus", () => {
    const r = identity("commitLoadWeight"); r.commit("0", "100");
    expect(r.patchDraft.mock.calls).toEqual([[{ loadWeight: "100" }]]);
    expect(r.onError.mock.calls).toEqual([["Load weight (lb): must be greater than zero."]]);
    expect(r.save).not.toHaveBeenCalled();
  });
  it("a blank clears the load weight", () => {
    const r = identity("commitLoadWeight"); r.commit("", "100");
    expect(r.save.mock.calls).toEqual([[{ loadWeight: null }]]);
    expect(r.patchDraft).not.toHaveBeenCalled(); expect(r.onError).not.toHaveBeenCalled();
  });
  it("spaces alone are a blank too", () => {
    const r = identity("commitLoadWeight"); r.commit("  ", "100");
    expect(r.save.mock.calls).toEqual([[{ loadWeight: null }]]);
  });
  it("a fitting figure is sent as typed", () => {
    const r = identity("commitLoadWeight"); r.commit("1250.50", "100");
    expect(r.save.mock.calls).toEqual([[{ loadWeight: "1250.50" }]]);
  });
  it("too many digits is named with the label", () => {
    const r = identity("commitLoadWeight"); r.commit("1.234", "100");
    expect(r.onError.mock.calls).toEqual([["Load weight (lb): use at most 2 digits after the point."]]);
    expect(r.patchDraft.mock.calls).toEqual([[{ loadWeight: "100" }]]);
  });
});

describe("PartsPage add (New part)", () => {
  function lift(eachWeight: string, api: () => Promise<unknown> = async () => ({})) {
    const draft = { customerId: "c1", partNumber: "P-1", eachWeight };
    const sent = vi.fn(api); const setError = vi.fn(); const setDraft = vi.fn();
    const run = callback<() => Promise<void>>("app/parts/page.tsx", "PartsPage", "add", {
      draft, api: sent, setError, setDraft, decimalRefusal, EACH_WEIGHT, addHold: oneShotHold(),
      invalidateSetupBanner: vi.fn(), loadRef: { current: vi.fn(async () => undefined) },
    });
    return { run, api: sent, setError, setDraft, draft };
  }
  async function add(eachWeight: string) {
    const r = lift(eachWeight); await r.run(); return r;
  }
  it("a figure the rule refuses is named, nothing is posted and the draft is kept", async () => {
    const r = await add("1e2");
    expect(r.setError.mock.calls).toEqual([["Each weight (lb): enter a number without $ or commas, such as 0.36."]]);
    expect(r.api).not.toHaveBeenCalled(); expect(r.setDraft).not.toHaveBeenCalled();
  });
  it("a blank is refused: Each weight is required", async () => {
    const r = await add("");
    expect(r.setError.mock.calls).toEqual([["Each weight (lb): must be greater than zero."]]);
    expect(r.api).not.toHaveBeenCalled();
  });
  it("a fitting figure posts the draft unchanged", async () => {
    const r = await add(".5");
    expect(r.api.mock.calls).toEqual([["/api/parts", { method: "POST", body: JSON.stringify(r.draft) }]]);
  });
  it("a second Add while the POST is out sends nothing (#720)", async () => {
    let answer!: () => void;
    const r = lift(".5", () => new Promise((resolve) => { answer = () => resolve({}); }));
    const first = r.run(); const second = r.run();
    await second;
    expect(r.api).toHaveBeenCalledTimes(1);
    answer(); await first;
    const third = r.run(); answer(); await third;
    expect(r.api).toHaveBeenCalledTimes(2); // the hold cleared when the first answer landed
    expect(JSON.parse((r.api.mock.calls[0] as unknown as [string, { body: string }])[1].body).eachWeight).toBe(".5");
  });
});

describe("InspectionsSection: a saved row's Min and Max", () => {
  const INSPECTIONS = "app/parts/[id]/InspectionsSection.tsx";
  const boxKey = (id: string, field: string) => `${id}.${field}`;
  function row() {
    const saveRow = vi.fn(async () => true); const setRowField = vi.fn(); const onError = vi.fn();
    const savedMarks = { mark: vi.fn() };
    const rows = [{ id: "r1", inspectionCodeId: "c1", inspectionCodeName: "Hardness" }];
    const codes = [{ id: "c1", name: "Hardness" }, { id: "c2", name: "Case Depth" }];
    const saveBox = callback<(id: string, field: string, value: string, sent: string | null) => Promise<string | false>>(
      INSPECTIONS, "InspectionsSection", "saveBox", { saveRow, savedMarks, boxKey });
    const env = { rows, codes, saveRow, saveBox, setRowField, onError, decimalRefusal, INSPECTION_MIN, INSPECTION_MAX };
    const commit = callback<(id: string, field: "min" | "max", value: string, atFocus: string) => false | Promise<string | false>>(
      INSPECTIONS, "InspectionsSection", "commitInspectionLimit", env);
    return { commit, saveRow, setRowField, onError, savedMarks, env };
  }
  it("a figure below zero is named with the code, the box goes back to what it held at focus, and the commit answers false", () => {
    const r = row();
    expect(r.commit("r1", "min", "-1", "40")).toBe(false);
    expect(r.onError.mock.calls).toEqual([["Hardness, Min: cannot be negative."]]);
    expect(r.setRowField.mock.calls).toEqual([["r1", "min", "40"]]);
    expect(r.saveRow).not.toHaveBeenCalled();
  });
  it("a row whose Code was just changed is named by the code it holds now, not the name it loaded with", () => {
    const r = row(); r.env.rows[0].inspectionCodeId = "c2"; r.commit("r1", "min", "-1", "40");
    expect(r.onError.mock.calls).toEqual([["Case Depth, Min: cannot be negative."]]);
  });
  it("too many digits after the point is named under Max", () => {
    const r = row();
    expect(r.commit("r1", "max", "1.23456", "60")).toBe(false);
    expect(r.onError.mock.calls).toEqual([["Hardness, Max: use at most 4 digits after the point."]]);
    expect(r.setRowField.mock.calls).toEqual([["r1", "max", "60"]]);
    expect(r.saveRow).not.toHaveBeenCalled();
  });
  it("a fitting figure is sent as typed, answers the typed text once it lands and marks the box Saved", async () => {
    const r = row();
    await expect(r.commit("r1", "min", "45", "40")).resolves.toBe("45");
    expect(r.saveRow.mock.calls).toEqual([["r1", { min: "45" }]]);
    expect(r.savedMarks.mark.mock.calls).toEqual([["r1.min", "45", { decimal: true }]]);
    expect(r.setRowField).not.toHaveBeenCalled(); expect(r.onError).not.toHaveBeenCalled();
  });
  it("a save that does not land answers false and marks nothing", async () => {
    const r = row(); r.saveRow.mockImplementationOnce(async () => false);
    await expect(r.commit("r1", "min", "45", "40")).resolves.toBe(false);
    expect(r.savedMarks.mark).not.toHaveBeenCalled();
  });
  it("a blank sends null, and spaces alone are a blank", () => {
    const r = row(); r.commit("r1", "max", "", "60"); r.commit("r1", "max", "  ", "60");
    expect(r.saveRow.mock.calls).toEqual([["r1", { max: null }], ["r1", { max: null }]]);
    expect(r.onError).not.toHaveBeenCalled();
  });
  describe("blurSave and enterSave, through the at-focus record (src/lib/focus-record.ts)", () => {
    function boxes(atFocus: string, field: "min" | "sampleQty") {
      const r = row();
      const focus = { current: focusRecord() };
      noteFocus(focus.current, boxKey("r1", field), atFocus);
      const commitBox = callback<(id: string, field: string) => BoxCommit>(INSPECTIONS, "InspectionsSection", "commitBox", {
        commitInspectionLimit: r.commit, saveBox: r.env.saveBox,
      });
      const env = { focus, boxKey, commitBox, leaveBox, enterBox };
      const blurSave = callback<(e: unknown, id: string, field: string) => void>(INSPECTIONS, "InspectionsSection", "blurSave", env);
      const enterSave = callback<(e: unknown, id: string, field: string) => void>(INSPECTIONS, "InspectionsSection", "enterSave", env);
      const enter = (value: string) => enterSave({ key: "Enter", currentTarget: { value }, preventDefault: vi.fn() }, "r1", field);
      const blur = (value: string) => blurSave({ target: { value } }, "r1", field);
      return { ...r, enter, blur };
    }
    it("an unchanged box sends and says nothing", () => {
      const r = boxes("40", "min"); r.blur("40");
      expect(r.saveRow).not.toHaveBeenCalled(); expect(r.onError).not.toHaveBeenCalled();
    });
    it("a changed Min goes through the check", () => {
      const r = boxes("40", "min"); r.blur("-1");
      expect(r.onError.mock.calls).toEqual([["Hardness, Min: cannot be negative."]]);
      expect(r.saveRow).not.toHaveBeenCalled();
    });
    it("a text field is sent as typed, unchecked", () => {
      const r = boxes("2", "sampleQty"); r.blur("-1 of 3");
      expect(r.saveRow.mock.calls).toEqual([["r1", { sampleQty: "-1 of 3" }]]);
      expect(r.onError).not.toHaveBeenCalled();
    });
    it("Enter saves the box, and leaving it after sends nothing more (R7)", async () => {
      const r = boxes("40", "min"); r.enter("45"); r.blur("45");
      await new Promise((res) => setTimeout(res, 0));
      r.blur("45");
      expect(r.saveRow.mock.calls).toEqual([["r1", { min: "45" }]]);
    });
    it("a refused Enter is the refused blur: the box goes back, and leaving it sends nothing", () => {
      const r = boxes("40", "min"); r.enter("-1"); r.blur("40");
      expect(r.onError.mock.calls).toEqual([["Hardness, Min: cannot be negative."]]);
      expect(r.setRowField.mock.calls).toEqual([["r1", "min", "40"]]);
      expect(r.saveRow).not.toHaveBeenCalled();
    });
  });
});

describe("InspectionsSection add (the Add row)", () => {
  async function add(min: string, max: string, over: { rowsReady?: boolean; inspectionCodeId?: string } = {}) {
    const draft = { inspectionCodeId: over.inspectionCodeId ?? "c1", scaleId: "", min, max, sampleQty: "", location: "" };
    const api = vi.fn(async () => ({})); const onError = vi.fn(); const setDraft = vi.fn();
    await callback<() => Promise<void>>("app/parts/[id]/InspectionsSection.tsx", "InspectionsSection", "add", {
      draft, rows: [], rowsReady: over.rowsReady ?? true, partId: "p1", api, onError, setDraft,
      load: vi.fn(async () => undefined), invalidateHistory: vi.fn(), emptyDraft: {},
      decimalRefusal, INSPECTION_MIN, INSPECTION_MAX,
      adding: { current: false }, setAddingState: vi.fn(), // #681: the one-request-in-flight hold
    })();
    return { api, onError, setDraft, draft };
  }
  // #681 (G5-3): a double-click used to send two POSTs and store two identical inspection rows,
  // which both printed on the traveler and seeded cert requirements. The hold is a ref, so the
  // second click of the same tick is refused too. Mutation: delete the `adding.current` check.
  it("a second click while the first POST is out sends nothing", async () => {
    const draft = { inspectionCodeId: "c1", scaleId: "", min: "40", max: "", sampleQty: "", location: "" };
    let release!: () => void;
    const held = new Promise<unknown>((resolve) => { release = () => resolve({}); });
    const api = vi.fn(() => held); const onError = vi.fn(); const setDraft = vi.fn();
    const adding = { current: false }; const setAddingState = vi.fn();
    const add = callback<() => Promise<void>>("app/parts/[id]/InspectionsSection.tsx", "InspectionsSection", "add", {
      draft, rows: [], rowsReady: true, partId: "p1", api, onError, setDraft,
      load: vi.fn(async () => undefined), invalidateHistory: vi.fn(), emptyDraft: {},
      decimalRefusal, INSPECTION_MIN, INSPECTION_MAX, adding, setAddingState,
    });
    const first = add();
    const second = add();
    expect(api).toHaveBeenCalledTimes(1);
    expect(adding.current).toBe(true);
    expect(setAddingState.mock.calls).toEqual([[true]]);
    release();
    await Promise.all([first, second]);
    expect(api).toHaveBeenCalledTimes(1);
    expect(adding.current).toBe(false);
    expect(setAddingState.mock.calls).toEqual([[true], [false]]);
  });
  it("each refused box is named on its own line, Min first, and nothing is posted", async () => {
    const r = await add("-1", "x");
    expect(r.onError.mock.calls).toEqual([[
      "Min: cannot be negative.\nMax: enter a number without $ or commas, such as 0.36.",
    ]]);
    expect(r.api).not.toHaveBeenCalled(); expect(r.setDraft).not.toHaveBeenCalled();
  });
  it("one refused box is one line", async () => {
    const r = await add("", "1.23456");
    expect(r.onError.mock.calls).toEqual([["Max: use at most 4 digits after the point."]]);
    expect(r.api).not.toHaveBeenCalled();
  });
  it("fitting and blank figures post as before", async () => {
    const r = await add("40", "");
    expect(r.api).toHaveBeenCalledTimes(1);
    const body = JSON.parse((r.api.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.min).toBe("40"); expect(body.max).toBeUndefined();
    expect(r.onError.mock.calls).toEqual([[null]]);
  });
  it("the code-selected and rows-ready guards still come first", async () => {
    const none = await add("-1", "-1", { inspectionCodeId: "" });
    expect(none.onError).not.toHaveBeenCalled(); expect(none.api).not.toHaveBeenCalled();
    const early = await add("-1", "-1", { rowsReady: false });
    expect(early.onError.mock.calls).toEqual([["Inspection rows have not finished loading yet — reload the page and try again."]]);
  });
});

// Ruling 19 (2026-10-22 review, G5-4): the part page's two whole-number boxes read the typed text
// through the whole-number rule, name the box in the refusal, roll the box back to what it held at
// focus, and send nothing; a blank still clears the figure; a figure that fits is sent as a number.
function wholeNumber(name: "commitLoadQty" | "commitRequestDaysOverride") {
  const save = vi.fn(async () => true); const patchDraft = vi.fn(); const onError = vi.fn();
  const commit = callback<(v: string, atFocus: string) => void>("app/parts/[id]/IdentitySection.tsx", "IdentitySection", name, {
    save, patchDraft, onError, wholeNumberRefusal, readWholeNumber, LOAD_QTY, REQUEST_DAYS_OVERRIDE,
  });
  return { commit, save, patchDraft, onError };
}

describe("IdentitySection: Load quantity (ruling 19)", () => {
  it("1e2 is refused by name, the box goes back to what it held at focus, and nothing is sent", () => {
    const r = wholeNumber("commitLoadQty"); r.commit("1e2", "12");
    expect(r.patchDraft.mock.calls).toEqual([[{ loadQty: "12" }]]);
    expect(r.onError.mock.calls).toEqual([["Load quantity must be a whole number of at least 1."]]);
    expect(r.save).not.toHaveBeenCalled();
  });
  it("0 is refused with the same sentence: the server's floor is named by the box", () => {
    const r = wholeNumber("commitLoadQty"); r.commit("0", "12");
    expect(r.onError.mock.calls).toEqual([["Load quantity must be a whole number of at least 1."]]);
    expect(r.save).not.toHaveBeenCalled();
  });
  it("a figure that fits is sent as a number, and a blank clears it", () => {
    const r = wholeNumber("commitLoadQty"); r.commit(" 36 ", "12"); r.commit("", "36");
    expect(r.save.mock.calls).toEqual([[{ loadQty: 36 }], [{ loadQty: null }]]);
    expect(r.onError).not.toHaveBeenCalled();
  });
});

describe("IdentitySection: Request days override (ruling 19)", () => {
  it("4000 is refused with the owner's ceiling sentence, and the box goes back", () => {
    const r = wholeNumber("commitRequestDaysOverride"); r.commit("4000", "5");
    expect(r.patchDraft.mock.calls).toEqual([[{ requestDaysOverride: "5" }]]);
    expect(r.onError.mock.calls).toEqual([["Request days override must be a whole number from 0 to 3650."]]);
    expect(r.save).not.toHaveBeenCalled();
  });
  it("0 and 3650 fit, and a blank clears it", () => {
    const r = wholeNumber("commitRequestDaysOverride"); r.commit("0", "5"); r.commit("3650", "0"); r.commit("", "3650");
    expect(r.save.mock.calls).toEqual([[{ requestDaysOverride: 0 }], [{ requestDaysOverride: 3650 }], [{ requestDaysOverride: null }]]);
  });
});

describe("the customer page: Request days override (ruling 19)", () => {
  function customerBox() {
    const save = vi.fn(async () => true); const setC = vi.fn(); const setError = vi.fn();
    const commit = callback<(v: string, atFocus: string) => void>("app/customers/[id]/page.tsx", "CustomerDetail", "commitRequestDaysOverride", {
      save, setC, setError, wholeNumberRefusal, readWholeNumber, REQUEST_DAYS_OVERRIDE,
    });
    return { commit, save, setC, setError };
  }
  it("1e2 is refused by name, the box goes back to what it held at focus, and nothing is sent", () => {
    const r = customerBox(); r.commit("1e2", "7");
    expect(r.setError.mock.calls).toEqual([["Request days override must be a whole number from 0 to 3650."]]);
    expect(r.save).not.toHaveBeenCalled();
    // The rollback is a functional setter over the current record (the page's own shape).
    expect(r.setC).toHaveBeenCalledTimes(1);
    const updater = r.setC.mock.calls[0][0] as (cur: { requestDaysOverride: unknown } | null) => unknown;
    expect(updater({ requestDaysOverride: "1e2" })).toEqual({ requestDaysOverride: "7" });
    expect(updater(null)).toBeNull();
  });
  it("a figure that fits is sent as a number, and a blank clears it", () => {
    const r = customerBox(); r.commit("30", "7"); r.commit("", "30");
    expect(r.save.mock.calls).toEqual([[{ requestDaysOverride: 30 }], [{ requestDaysOverride: null }]]);
  });
});
