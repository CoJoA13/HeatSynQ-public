import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderTotals } from "@/lib/order-totals";
import { blankContainer, blankDraft, compactDraft, isDraftEmpty, normalizeDraft,
  type ContainerDraft, type ContainerTypeOption } from "../src/app/orders/new/order-draft";
import { CONTAINER_TYPES_NOT_LOADED, changeLeadAdjustment, createOrderAutosaveController, entryContainerBody,
  entryTotalsInput, isCurrentDraftSaved, reconcileTravelerSelection, type DraftPrompt } from "../src/app/orders/new/entry-state";

describe("order-entry draft compatibility", () => {
  it("keeps an untouched visit empty despite generated row ids and request nonce", () => {
    const draft = blankDraft();
    expect(draft.clientRequestId).toBeTruthy();
    expect(isDraftEmpty(draft)).toBe(true);
    expect(isDraftEmpty(normalizeDraft({}))).toBe(true);
  });

  it("round-trips all typed legacy fields and the same request nonce", () => {
    const legacy = {
      clientRequestId: "d352e351-e39f-4ced-8cc3-037433274530",
      customerId: "customer-1", poOverride: "", vsOrderNumber: "VS-19", customerJobNo: "JOB-4",
      certRequiredOverride: false, certScopeOverride: "ORDER", receivedDateOverride: "2026-09-01",
      requestDateOverride: "2026-09-04", targetDate: "2026-09-08", notes: "Keep upright",
      lines: [{ id: "line-1", partId: "part-1", qty: "0003", weightOverride: " 12.30 ",
        serials: [{ id: "serial-1", serial: "EC001", description: "Left" }], quoteLineIdOverride: null }],
      containers: [{ id: "container-1", typeId: "type-1", count: "02", pieces: "", tareEachOverride: "0.10",
        scaleGross: "12.40", customerContainerId: "BIN-9" }],
      charges: [{ id: "charge-1", description: " Handling ", amount: " 10.20 " }],
    };
    const restored = normalizeDraft(JSON.parse(JSON.stringify(legacy)));
    expect(restored).toEqual({ ...legacy,
      loadAdjustmentDraft: { enabled: false, leadPartId: null, loadQty: "", loadWeight: "" },
      travelerSelection: { mode: "all" },
    });
    expect(normalizeDraft(restored).clientRequestId).toBe(legacy.clientRequestId);
  });

  it.each([undefined, null, "quote-line-1"])("preserves quote choice %s through JSON", choice => {
    const draft = blankDraft();
    draft.lines[0].quoteLineIdOverride = choice;
    const restored = normalizeDraft(JSON.parse(JSON.stringify(draft)));
    expect(restored.lines[0].quoteLineIdOverride).toBe(choice);
    expect(isDraftEmpty(restored)).toBe(choice === undefined);
  });

  // #663: the autosave stores each line's serials as [serial, description] pairs, without the
  // 36-character client ids that made a 3,200-serial draft outgrow the cap; a resumed draft mints
  // ids on read, as it always did, and a draft stored in the old object shape still resumes.
  it("stores serials compactly and resumes either shape with fresh ids", () => {
    const base = blankDraft();
    const draft = { ...base, lines: [{ ...base.lines[0], partId: "part-1", qty: "2",
      serials: [{ id: "serial-1", serial: "EC001", description: "Left" }, { id: "serial-2", serial: "EC002", description: "" }] }] };
    const stored = compactDraft(draft) as { lines: { serials: unknown }[] };
    expect(stored.lines[0].serials).toEqual([["EC001", "Left"], ["EC002", ""]]);
    expect(JSON.stringify(stored)).not.toContain("serial-1");
    const resumed = normalizeDraft(JSON.parse(JSON.stringify(stored)));
    expect(resumed.lines[0].serials.map(({ serial, description }) => ({ serial, description })))
      .toEqual([{ serial: "EC001", description: "Left" }, { serial: "EC002", description: "" }]);
    expect(resumed.lines[0].serials.every((s) => typeof s.id === "string" && s.id.length > 0)).toBe(true);
    const legacy = normalizeDraft({ lines: [{ serials: [{ id: "serial-9", serial: "EC009", description: "Old" }] }] });
    expect(legacy.lines[0].serials).toEqual([{ id: "serial-9", serial: "EC009", description: "Old" }]);
    // A malformed pair resumes as a blank serial rather than throwing.
    expect(normalizeDraft({ lines: [{ serials: [["EC010"], [7, 8], "x"] }] }).lines[0].serials.map((s) => [s.serial, s.description]))
      .toEqual([["EC010", ""], ["", ""], ["", ""]]);
  });

  it("normalizes malformed legacy fields without freezing server defaults", () => {
    const draft = normalizeDraft({ lines: [{ qty: 3, weightOverride: 2, quoteLineIdOverride: false }],
      certRequiredOverride: "false", certScopeOverride: "invented", containers: [{}], charges: [{}],
      preview: { fingerprint: "server-derived" }, expectedPreviewFingerprint: "server-derived" });
    expect(draft.lines[0]).toMatchObject({ qty: "", weightOverride: null, quoteLineIdOverride: undefined });
    expect(draft.certRequiredOverride).toBeNull();
    expect(draft.certScopeOverride).toBeNull();
    expect(draft.containers[0]).toMatchObject({ customerContainerId: "", count: "", pieces: "",
      tareEachOverride: null, scaleGross: "" });
    expect(draft.charges[0]).toMatchObject({ description: "", amount: "" });
    expect(draft).not.toHaveProperty("preview");
    expect(draft).not.toHaveProperty("expectedPreviewFingerprint");
  });
  it("preserves new typed adjustment strings and sorts a valid selected-load set", () => {
    const draft = normalizeDraft({ loadAdjustmentDraft: { enabled: true, leadPartId: "part-a",
      loadQty: "0010", loadWeight: " 25.50 " }, travelerSelection: { mode: "loads", loadNumbers: [3, 1] } });
    expect(draft.loadAdjustmentDraft).toEqual({ enabled: true, leadPartId: "part-a",
      loadQty: "0010", loadWeight: " 25.50 " });
    expect(draft.travelerSelection).toEqual({ mode: "loads", loadNumbers: [1, 3] });
    expect(isDraftEmpty(draft)).toBe(false);
  });

  it.each([undefined, null, {}, { mode: "unknown" }, { mode: "loads", loadNumbers: [] },
    { mode: "loads", loadNumbers: [1, 1] }, { mode: "loads", loadNumbers: [1, "2"] },
    { mode: "loads", loadNumbers: [1, -2] }, { mode: "loads", loadNumbers: [1, 2.5] },
    { mode: "loads", loadNumbers: [1], extra: true }])("never salvages a subset from invalid stored selection %j", raw => {
    expect(normalizeDraft({ travelerSelection: raw }).travelerSelection).toEqual({ mode: "all" });
  });
});

describe("order entry's container rows in the draft", () => {
  it("starts a row with no Pieces, no typed tare each and no scale gross", () => {
    expect(blankContainer()).toMatchObject({ typeId: null, count: "", pieces: "", tareEachOverride: null,
      scaleGross: "", customerContainerId: "" });
  });

  // null is a box that was never typed in: it shows the type's default and follows a change of
  // type. "" is a box the operator cleared, and "50" is their figure. All three come back as they went.
  it.each([null, "", "50"])("keeps the tare each override %j through JSON", override => {
    const draft = blankDraft();
    draft.containers = [{ ...blankContainer(), typeId: "type-1", tareEachOverride: override }];
    const restored = normalizeDraft(JSON.parse(JSON.stringify(draft)));
    expect(restored.containers[0].tareEachOverride).toBe(override);
  });

  it.each([42.5, false, undefined, {}])("reads a stored override of %j as no override", stored => {
    expect(normalizeDraft({ containers: [{ tareEachOverride: stored }] }).containers[0].tareEachOverride).toBeNull();
  });

  it("resumes a row saved before the change with its type, count and customer container id, and no figure", () => {
    const before = { id: "container-1", typeId: "type-1", count: "3", qty: "84", tareWeight: "42.50",
      grossWeight: "580.00", customerContainerId: "BIN-9" };
    expect(normalizeDraft({ containers: [before] }).containers).toEqual([{ id: "container-1", typeId: "type-1",
      count: "3", pieces: "", tareEachOverride: null, scaleGross: "", customerContainerId: "BIN-9" }]);
  });
});

const TYPES: ContainerTypeOption[] = [
  { id: "steel", name: "Steel Basket", tareEach: 42.5 },
  { id: "wire", name: "Wire Basket", tareEach: null },
];
const row = (over: Partial<ContainerDraft> = {}): ContainerDraft => ({ id: "c1", typeId: "steel", count: "3",
  pieces: "252", tareEachOverride: null, scaleGross: "", customerContainerId: "", ...over });

describe("order entry's container row in the create body", () => {
  it("sends the type's default while the Tare each box was never typed in, and stores nothing in the draft", () => {
    const untouched = row();
    expect(entryContainerBody(untouched, TYPES)).toEqual({ typeId: "steel", count: 3, pieces: 252, tareEach: "42.5",
      scaleGross: null, customerContainerId: "" });
    expect(untouched.tareEachOverride).toBeNull();
  });

  it("sends the operator's own text, trimmed, in place of the default", () => {
    expect(entryContainerBody(row({ tareEachOverride: " 50.00 " }), TYPES).tareEach).toBe("50.00");
  });

  it.each(["", "  "])("sends no tare each for a cleared box (%j), whatever the type's default", cleared => {
    expect(entryContainerBody(row({ tareEachOverride: cleared }), TYPES).tareEach).toBeNull();
  });

  it("sends no tare each when nothing was typed and the type has no default, or no type is picked", () => {
    expect(entryContainerBody(row({ typeId: "wire" }), TYPES).tareEach).toBeNull();
    expect(entryContainerBody(row({ typeId: null }), TYPES).tareEach).toBeNull();
  });

  it("sends blank Pieces and a blank Scale gross as null, and a typed Scale gross trimmed", () => {
    expect(entryContainerBody(row({ pieces: " ", scaleGross: " 580.00 ", customerContainerId: "BIN-9" }), TYPES))
      .toEqual({ typeId: "steel", count: 3, pieces: null, tareEach: "42.5", scaleGross: "580.00",
        customerContainerId: "BIN-9" });
  });
});

describe("what order entry hands the totals table", () => {
  const PARTS = [{ id: "p", eachWeight: 6.4 }, { id: "q", eachWeight: 2 }];
  /** A line as the page gives it once it is complete: 250 pieces of part p, 1,600.00 lb. */
  const CHECKED = { partId: "p", qty: 250, weight: 1600 };
  type Handed = Parameters<typeof entryTotalsInput>[0];
  /** Order 1004 as order entry holds it: one line of part p, and three steel baskets of 252
   *  pieces whose Tare each box was never typed in. */
  const handed = (over: Partial<Handed> = {}) => entryTotalsInput({ draftLines: [{ partId: "p" }], lines: [CHECKED],
    parts: PARTS, containers: [row()], containerTypes: TYPES, ...over });

  it("gives each line's checked quantity and weight, each line's part with its each weight, and each row's four figures", () => {
    expect(handed()).toStrictEqual({
      lines: [{ qty: 250, weight: 1600 }],
      lineParts: [{ partId: "p", eachWeight: 6.4 }],
      containers: [{ count: "3", pieces: "252", tareEach: "42.5", scaleGross: "" }],
    });
  });

  it("gives a line's checked weight as it is, and its part's each weight, when the weight was typed over (W5, W6)", () => {
    // 1,700.00 lb for 250 pieces of a part at 6.4 lb each: the weight is not the quantity times the
    // each weight, and the each weight is not the weight over the quantity.
    const given = handed({ lines: [{ ...CHECKED, weight: 1700 }] });
    expect(given.lines).toStrictEqual([{ qty: 250, weight: 1700 }]);
    expect(given.lineParts).toStrictEqual([{ partId: "p", eachWeight: 6.4 }]);
  });

  it.each<[string, Partial<Handed>]>([
    ["the one line is not complete", { lines: [null] }],
    ["one line of two is not complete", { draftLines: [{ partId: "p" }, { partId: "p" }], lines: [CHECKED, null] }],
    ["there is no line", { draftLines: [], lines: [] }],
  ])("gives no line figures while %s", (_what, over) => {
    expect(handed(over).lines).toBeNull();
  });

  it("still gives each line's part while the lines' figures cannot be given (W6)", () => {
    expect(handed({ draftLines: [{ partId: "p" }, { partId: "p" }], lines: [CHECKED, null] }).lineParts)
      .toStrictEqual([{ partId: "p", eachWeight: 6.4 }, { partId: "p", eachWeight: 6.4 }]);
  });

  it("gives a line with no part no part, and a part the customer's catalog lacks no each weight", () => {
    expect(handed({ draftLines: [{ partId: null }, { partId: "gone" }, { partId: "q" }], lines: [null, null, null] }).lineParts)
      .toStrictEqual([{ partId: null, eachWeight: null }, { partId: "gone", eachWeight: null }, { partId: "q", eachWeight: 2 }]);
  });

  it.each<[string, Partial<ContainerDraft>, ContainerTypeOption[], string]>([
    ["the type's default, which the draft never stores", {}, TYPES, "42.5"],
    ["typed text, over the default", { tareEachOverride: "50" }, TYPES, "50"],
    ["a cleared box", { tareEachOverride: "" }, TYPES, ""],
    ["a type with no default", { typeId: "wire" }, TYPES, ""],
    ["no type", { typeId: null }, TYPES, ""],
    ["a resumed row while the type list is empty", {}, [], ""],
  ])("gives a row's Tare each as its box shows it: %s", (_what, over, containerTypes, tareEach) => {
    expect(handed({ containers: [row(over)], containerTypes }).containers)
      .toStrictEqual([{ count: "3", pieces: "252", tareEach, scaleGross: "" }]);
  });

  it("gives Containers, Pieces and Scale gross as they were typed", () => {
    expect(handed({ containers: [row({ count: " 3 ", pieces: "abc", scaleGross: "1740" })] }).containers)
      .toStrictEqual([{ count: " 3 ", pieces: "abc", tareEach: "42.5", scaleGross: "1740" }]);
  });

  // Through the leaf, as the page calls it: the cases the design's §10.5 names.
  const shown = (over: Partial<Handed> = {}) => {
    const { rows, note, weighed } = orderTotals(handed(over));
    return { cells: rows.map((cell) => [cell.pieces, cell.net, cell.tare, cell.gross]), note, weighed };
  };
  const WEIGHED = [row({ scaleGross: "1740" })];

  it("lets a default the draft never stores reach the table", () => {
    expect(shown()).toEqual({
      cells: [["250", "1,600.00", "", ""], ["252", "", "127.50", ""], ["", "1,600.00", "127.50", "1,727.50"]],
      note: null, weighed: [] });
  });

  it("reads a resumed row as a row with no Tare each while the type list is empty", () => {
    expect(shown({ containerTypes: [] })).toEqual({
      cells: [["250", "1,600.00", "", ""], ["252", "", "Incomplete", ""], ["", "1,600.00", "Incomplete", "Not available"]],
      note: "1 row has no Tare each", weighed: [] });
  });

  it("shows Implied pieces for a line whose part is picked and whose quantity is not typed, and none for a line with no part", () => {
    expect(shown({ lines: [null], containers: WEIGHED }).weighed).toEqual(["Weighed net 1,612.50 lb", "Implied pieces 252"]);
    expect(shown({ draftLines: [{ partId: null }], lines: [null], containers: WEIGHED }).weighed)
      .toEqual(["Weighed net 1,612.50 lb"]);
  });
});

describe("order entry's sentence for container types that could not be read (E1)", () => {
  it("is the approved sentence, word for word", () => {
    expect(CONTAINER_TYPES_NOT_LOADED).toBe("Container types could not be loaded, so a row's Type shows blank and "
      + "its Tare each is not filled in. Reload the page once it reads Draft saved, or type each Tare each.");
  });
});

describe("order-entry generation and plan reconciliation", () => {
  it("acknowledges only the completed generation", () => {
    expect(isCurrentDraftSaved(5, 4)).toBe(false);
    expect(isCurrentDraftSaved(5, 5)).toBe(true);
  });

  it("resets selected loads when the plan changes", () => {
    expect(reconcileTravelerSelection({ mode: "loads", loadNumbers: [2] }, "plan-a", "plan-b"))
      .toEqual({ selection: { mode: "all" }, notice: "Load plan changed; all loads are selected." });
  });

  it("resets an adjustment bound to the previous lead", () => {
    const draft = blankDraft();
    draft.loadAdjustmentDraft = { enabled: true, leadPartId: "part-a", loadQty: "10", loadWeight: "25.50" };
    const result = changeLeadAdjustment(draft, "part-b");
    expect(result.draft.loadAdjustmentDraft)
      .toEqual({ enabled: false, leadPartId: null, loadQty: "", loadWeight: "" });
    expect(result.notice).toBeTruthy();
    expect(draft.loadAdjustmentDraft.enabled).toBe(true);
  });

  it("keeps an adjustment and selection when their lead and plan identities are unchanged", () => {
    const draft = blankDraft();
    draft.loadAdjustmentDraft = { enabled: true, leadPartId: "part-a", loadQty: "10", loadWeight: "25.50" };
    expect(changeLeadAdjustment(draft, "part-a")).toEqual({ draft, notice: null });
    expect(reconcileTravelerSelection({ mode: "loads", loadNumbers: [2] }, "plan-a", "plan-a"))
      .toEqual({ selection: { mode: "loads", loadNumbers: [2] }, notice: null });
    expect(reconcileTravelerSelection({ mode: "loads", loadNumbers: [2] }, null, "new-plan"))
      .toEqual({ selection: { mode: "all" }, notice: "Load plan changed; all loads are selected." });
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(row: DraftPrompt | null = null) {
  const transport = {
    read: vi.fn<() => Promise<DraftPrompt | null>>().mockResolvedValue(row),
    put: vi.fn<Parameters<typeof createOrderAutosaveController>[1]["put"]>().mockResolvedValue(undefined),
    clear: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
  };
  const controller = createOrderAutosaveController(blankDraft(), transport);
  const edit = (notes: string) => controller.setDraft(draft => ({ ...draft, notes }));
  return { controller, transport, edit };
}

describe("the production autosave controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not write an untouched empty visit", async () => {
    const h = harness();
    await h.controller.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.controller.getSnapshot().saveState).toEqual({ status: "idle", acknowledgedGeneration: 0 });
    expect(h.transport.put).not.toHaveBeenCalled();
    expect(h.transport.clear).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it("keeps B dirty when autosave A succeeds after B was typed", async () => {
    const h = harness(), a = deferred();
    h.transport.put.mockReturnValueOnce(a.promise);
    await h.controller.start();
    h.edit("A");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.controller.getSnapshot().saveState.status).toBe("saving");
    h.edit("B");
    a.resolve();
    await h.controller.settled();
    expect(h.controller.getSnapshot()).toMatchObject({ draft: { notes: "B" }, generation: 2,
      saveState: { status: "dirty", acknowledgedGeneration: 1 } });
    expect(h.transport.put.mock.calls[0][0].notes).toBe("A");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.controller.getSnapshot().saveState).toEqual({ status: "saved", acknowledgedGeneration: 2 });
    expect(h.transport.put.mock.calls[1][0].notes).toBe("B");
    h.controller.stop();
  });

  it("retains B and reports A's failure without acknowledging B", async () => {
    const h = harness(), a = deferred();
    h.transport.put.mockReturnValueOnce(a.promise);
    await h.controller.start();
    h.edit("A");
    await vi.advanceTimersByTimeAsync(2000);
    h.edit("B");
    a.reject(new Error("offline"));
    await h.controller.settled();
    expect(h.controller.getSnapshot()).toMatchObject({ draft: { notes: "B" }, generation: 2,
      saveState: { status: "dirty", acknowledgedGeneration: 0, message: "Draft autosave failed: offline" } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.controller.getSnapshot().saveState).toEqual({ status: "saved", acknowledgedGeneration: 2 });
    h.controller.stop();
  });

  it("serializes queued snapshots and makes Save wait for every dispatched autosave", async () => {
    const h = harness(), a = deferred(), b = deferred();
    h.transport.put.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await h.controller.start();
    h.edit("A");
    await vi.advanceTimersByTimeAsync(2000);
    h.edit("B");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.transport.put).toHaveBeenCalledTimes(1);
    const create = vi.fn();
    const barrier = h.controller.beginSave().then(create);
    a.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.transport.put).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().saveState.acknowledgedGeneration).toBe(1);
    b.resolve();
    await barrier;
    expect(create).toHaveBeenCalledOnce();
    h.controller.stop();
  });

  it("clears an existing draft when typing is cleared back to blank", async () => {
    const h = harness();
    await h.controller.start();
    h.edit("typed");
    await vi.advanceTimersByTimeAsync(2000);
    h.edit("");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.transport.put).toHaveBeenCalledOnce();
    expect(h.transport.clear).toHaveBeenCalledOnce();
    expect(h.controller.getSnapshot().saveState).toEqual({ status: "saved", acknowledgedGeneration: 2 });
    h.controller.stop();
  });

  it("reports a failed clear and recovers on the next edit", async () => {
    const h = harness();
    await h.controller.start();
    h.edit("typed");
    await vi.advanceTimersByTimeAsync(2000);
    h.transport.clear.mockRejectedValueOnce(new Error("clear unavailable"));
    h.edit("");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.controller.getSnapshot().saveState).toEqual({ status: "error", acknowledgedGeneration: 1,
      message: "Draft autosave failed: clear unavailable" });
    h.edit("corrected");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.controller.getSnapshot().saveState).toEqual({ status: "saved", acknowledgedGeneration: 3 });
    h.controller.stop();
  });

  it("cancels pending debounce for Save then recovers the same draft after failed create", async () => {
    const h = harness();
    await h.controller.start();
    h.edit("A");
    const before = h.controller.getSnapshot().draft;
    await h.controller.beginSave();
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.transport.put).not.toHaveBeenCalled();
    h.controller.saveFailed();
    expect(h.controller.getSnapshot().draft).toBe(before);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.transport.put).toHaveBeenCalledWith(before);
    h.edit("B after failed create");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.transport.put.mock.calls[1][0]).toMatchObject({ notes: "B after failed create",
      clientRequestId: before.clientRequestId });
    h.controller.stop();
  });

  it("recovers edits typed while create is in flight when that create fails", async () => {
    const h = harness();
    await h.controller.start();
    h.edit("submitted");
    await h.controller.beginSave();
    h.edit("edited during create");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.transport.put).not.toHaveBeenCalled();
    h.controller.saveFailed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.transport.put).toHaveBeenCalledExactlyOnceWith(h.controller.getSnapshot().draft);
    expect(h.controller.getSnapshot()).toMatchObject({ draft: { notes: "edited during create" },
      saveState: { status: "saved", acknowledgedGeneration: 2 } });
    h.controller.stop();
  });

  it("settles a failed autosave before allowing create without dropping the typed draft", async () => {
    const h = harness(), a = deferred();
    h.transport.put.mockReturnValueOnce(a.promise);
    await h.controller.start();
    h.edit("A");
    await vi.advanceTimersByTimeAsync(2000);
    const create = vi.fn();
    const barrier = h.controller.beginSave().then(create);
    expect(create).not.toHaveBeenCalled();
    a.reject(new Error("autosave offline"));
    await barrier;
    expect(create).toHaveBeenCalledOnce();
    expect(h.controller.getSnapshot()).toMatchObject({ draft: { notes: "A" }, saveState: { status: "error" } });
    h.controller.stop();
  });

  it("never resurrects a draft after successful create, even on remount or recovery callbacks", async () => {
    const h = harness(), a = deferred();
    h.transport.put.mockReturnValueOnce(a.promise);
    await h.controller.start();
    h.edit("A");
    await vi.advanceTimersByTimeAsync(2000);
    h.edit("B pending debounce");
    const barrier = h.controller.beginSave();
    a.resolve();
    await barrier;
    h.controller.saveSucceeded();
    h.controller.saveFailed();
    h.edit("late edit");
    h.controller.stop();
    await h.controller.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.transport.put).toHaveBeenCalledTimes(1);
    expect(h.transport.clear).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().draft.notes).toBe("B pending debounce");
    h.controller.stop();
  });

  it("holds the resume gate and preserves the nonce when recovering stored work", async () => {
    const stored = { ...blankDraft(), notes: "recover me" };
    const h = harness({ payload: stored, updatedAt: "2026-09-21T12:00:00Z" });
    await h.controller.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.controller.getSnapshot().draftReady).toBe(false);
    expect(h.transport.put).not.toHaveBeenCalled();
    h.controller.resumeDraft();
    expect(h.controller.getSnapshot()).toMatchObject({ draftReady: true, draftPrompt: null,
      draft: { clientRequestId: stored.clientRequestId, notes: "recover me" } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.transport.put).toHaveBeenCalledWith(normalizeDraft(stored));
    h.controller.stop();
  });

  it("clears a resumed legacy blank rather than treating it as an untouched visit", async () => {
    const h = harness({ payload: {}, updatedAt: "2026-09-21T12:00:00Z" });
    await h.controller.start();
    h.controller.resumeDraft();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.transport.clear).toHaveBeenCalledOnce();
    expect(h.transport.put).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it("reports a recovery read failure and allows entry without an empty write", async () => {
    const h = harness();
    h.transport.read.mockRejectedValueOnce(new Error("read unavailable"));
    await h.controller.start();
    expect(h.controller.getSnapshot()).toMatchObject({ draftReady: true, draftPromptError: "read unavailable" });
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.transport.put).not.toHaveBeenCalled();
    h.edit("new work");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.transport.put).toHaveBeenCalledOnce();
    h.controller.stop();
  });

  it("keeps a failed discard recoverable and prevents Resume racing its pending delete", async () => {
    const row = { payload: { ...blankDraft(), notes: "recover me" }, updatedAt: "2026-09-21T12:00:00Z" };
    const h = harness(row), clear = deferred();
    h.transport.clear.mockReturnValueOnce(clear.promise);
    await h.controller.start();
    const discard = h.controller.discardDraft();
    h.controller.resumeDraft();
    expect(h.controller.getSnapshot()).toMatchObject({ draftReady: false, draftPrompt: row, draftPromptBusy: true });
    clear.reject(new Error("delete unavailable"));
    await discard;
    expect(h.controller.getSnapshot()).toMatchObject({ draftReady: false, draftPrompt: row,
      draftPromptBusy: false, draftPromptError: "delete unavailable" });
    h.controller.resumeDraft();
    expect(h.controller.getSnapshot()).toMatchObject({ draftReady: true, draftPromptError: null,
      draft: { notes: "recover me" } });
    h.controller.stop();
  });

  it("allows retrying Discard after an error without replacing the blank form's nonce", async () => {
    const h = harness({ payload: { notes: "old work" }, updatedAt: "2026-09-21T12:00:00Z" });
    const initial = h.controller.getSnapshot().draft;
    h.transport.clear.mockRejectedValueOnce(new Error("offline"));
    await h.controller.start();
    await h.controller.discardDraft();
    await h.controller.discardDraft();
    expect(h.controller.getSnapshot()).toMatchObject({ draftReady: true, draftPrompt: null, draftPromptError: null });
    expect(h.controller.getSnapshot().draft).toBe(initial);
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.transport.put).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it("ignores the first mount's late read after the hook lifecycle restarts", async () => {
    const h = harness(), first = deferred<DraftPrompt | null>();
    h.transport.read.mockReturnValueOnce(first.promise);
    const initialRead = h.controller.start();
    h.controller.stop();
    await h.controller.start();
    h.edit("current work");
    first.resolve({ payload: { notes: "stale work" }, updatedAt: "2026-09-21T12:00:00Z" });
    await initialRead;
    expect(h.controller.getSnapshot()).toMatchObject({ draftReady: true, draftPrompt: null,
      draft: { notes: "current work" } });
    h.controller.stop();
  });
});
