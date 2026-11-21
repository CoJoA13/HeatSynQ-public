import { beforeEach, describe, expect, it } from "vitest";
import { answerModal, askConfirm, askPassword, askReason, currentModal, makeCloseTracker, sendPassword, splitReasonText, subscribeModal, _resetModalsForTests } from "@/lib/modal";
import { reasonPromptText } from "@/lib/reason-prompt";

/**
 * The one modal's leaf (spec 2026-10-30 §4.3, ruling 5): a queue of requests the host renders one
 * at a time. The reason form takes its words from `reasonPromptText`, split at the blank line;
 * a blank reason holds the dialog open with the caller's own refusal sentence; Cancel resolves
 * `null` exactly as `prompt()` does, so every caller keeps its own null check.
 */
beforeEach(() => _resetModalsForTests());

describe("splitReasonText", () => {
  it("splits the leaf's text at its blank line into the question and the box's label", () => {
    expect(splitReasonText(reasonPromptText("Void order #1001?", "voiding")))
      .toEqual({ title: "Void order #1001?", body: "Reason for voiding (recorded in the audit history):" });
  });
});

describe("the modal queue", () => {
  it("starts empty", () => { expect(currentModal()).toBeNull(); });

  it("queues: the second request opens when the first is answered", async () => {
    const a = askConfirm({ title: "A", body: "", confirm: "Yes" });
    const b = askConfirm({ title: "B", body: "", confirm: "Yes", danger: true });
    expect(currentModal()).toMatchObject({ kind: "confirm", title: "A", danger: false });
    answerModal(currentModal()!.id, true);
    expect(await a).toBe(true);
    expect(currentModal()).toMatchObject({ kind: "confirm", title: "B", danger: true });
    answerModal(currentModal()!.id, false);
    expect(await b).toBe(false);
    expect(currentModal()).toBeNull();
  });

  it("a blank reason holds the dialog open and marks it; a typed reason resolves", async () => {
    const p = askReason({ question: "Void order #1001?", verb: "voiding", blankRefusal: "A reason is required to void an order." });
    const id = currentModal()!.id;
    expect(currentModal()).toMatchObject({ kind: "reason", title: "Void order #1001?", body: "Reason for voiding (recorded in the audit history):", blank: false });
    answerModal(id, "   ");
    expect(currentModal()).toMatchObject({ id, blank: true, blankRefusal: "A reason is required to void an order." });
    answerModal(id, "Duplicate");
    expect(await p).toBe("Duplicate");
    expect(currentModal()).toBeNull();
  });

  it("Cancel resolves null", async () => {
    const q = askReason({ question: "Void?", verb: "voiding", blankRefusal: "x" });
    answerModal(currentModal()!.id, null);
    expect(await q).toBeNull();
  });

  it("an answer for a request that is not current is ignored", async () => {
    const a = askConfirm({ title: "A", body: "", confirm: "Yes" });
    answerModal(999, true);
    expect(currentModal()).toMatchObject({ title: "A" });
    answerModal(currentModal()!.id, true);
    expect(await a).toBe(true);
  });

  it("tells its subscribers on every change", () => {
    let calls = 0;
    const off = subscribeModal(() => { calls += 1; });
    void askConfirm({ title: "A", body: "", confirm: "Yes" });
    answerModal(currentModal()!.id, true);
    off();
    void askConfirm({ title: "B", body: "", confirm: "Yes" });
    expect(calls).toBe(2);
  });
});

describe("the host's close tracker", () => {
  // A native <dialog> queues its `close` event as a task, so a close the host itself called can
  // fire after the caller's continuation has already asked the next question; that event must not
  // answer the new request. Each host-initiated close yields exactly one event, counted here.
  it("counts the host's own closes so their events answer nothing; a user's close answers", () => {
    const tracker = makeCloseTracker();
    expect(tracker.onClose()).toBe(true);
    tracker.beginHostClose();
    expect(tracker.onClose()).toBe(false);
    expect(tracker.onClose()).toBe(true);
    tracker.beginHostClose(); tracker.beginHostClose();
    expect(tracker.onClose()).toBe(false);
    expect(tracker.onClose()).toBe(false);
    expect(tracker.onClose()).toBe(true);
  });
});

// PR 12 (#827): Set password stays open across the caller's write and shows its refusal.
describe("the password request", () => {
  const ask = (submit: (password: string) => Promise<string | null>) =>
    askPassword({ title: "Set password for pat", label: "New password", confirm: "Set password", submit });

  it("resolves true once the caller's write lands, closing the dialog", async () => {
    const sent: string[] = [];
    const p = ask(async (password) => { sent.push(password); return null; });
    expect(currentModal()).toMatchObject({ kind: "password", title: "Set password for pat", label: "New password", confirm: "Set password", refusal: null, sending: false });
    await sendPassword(currentModal()!.id, "longenough");
    expect(sent).toEqual(["longenough"]);
    expect(await p).toBe(true);
    expect(currentModal()).toBeNull();
  });

  it("stays open with the caller's sentence on a refusal, and a later good one lands", async () => {
    const answers: (string | null)[] = ["Too short", null];
    const p = ask(async () => answers.shift()!);
    const id = currentModal()!.id;
    await sendPassword(id, "x");
    expect(currentModal()).toMatchObject({ id, refusal: "Too short", sending: false });
    await sendPassword(id, "longenough");
    expect(await p).toBe(true);
  });

  it("marks the send, and a second send while one is out does nothing", async () => {
    let release: (v: string | null) => void = () => {};
    const sends: string[] = [];
    const p = ask((password) => { sends.push(password); return new Promise((r) => { release = r; }); });
    const id = currentModal()!.id;
    const first = sendPassword(id, "longenough");
    expect(currentModal()).toMatchObject({ sending: true, refusal: null });
    await sendPassword(id, "again");
    expect(sends).toEqual(["longenough"]);
    release(null);
    await first;
    expect(await p).toBe(true);
  });

  it("Cancel resolves false; a write landing after it resolves nothing and touches the next request", async () => {
    let release: (v: string | null) => void = () => {};
    const p = ask(() => new Promise((r) => { release = r; }));
    const id = currentModal()!.id;
    const out = sendPassword(id, "longenough");
    answerModal(id, null);
    expect(await p).toBe(false);
    const next = askConfirm({ title: "B", body: "", confirm: "Yes" });
    release("Too short");
    await out;
    expect(currentModal()).toMatchObject({ kind: "confirm", title: "B" });
    answerModal(currentModal()!.id, false);
    await next;
  });

  it("a send under an id that is not current does nothing", async () => {
    const sends: string[] = [];
    const p = ask(async (password) => { sends.push(password); return null; });
    await sendPassword(currentModal()!.id + 1, "x");
    expect(sends).toEqual([]);
    answerModal(currentModal()!.id, null);
    await p;
  });
});
