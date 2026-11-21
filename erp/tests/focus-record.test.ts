import { describe, expect, it, vi } from "vitest";
import { enterBox, focusRecord, heldText, leaveBox, noteFocus, trimmedText, withoutSettledDraft, type BoxCommit } from "@/lib/focus-record";
import { sameSentValue } from "@/lib/line-field-saves";

// Owner ruling R7, P8 step 5: the at-focus record a blur-save box outside the edit guard keeps,
// and the one decision its blur and its Enter make from it. Pure leaf, driven with deferred saves
// (the use-edit-guard.test.ts shape); every case below reds with the guard it names deleted.

const kev = (key: string, opts: { isComposing?: boolean } = {}) => ({
  key, nativeEvent: { isComposing: opts.isComposing ?? false }, preventDefault: vi.fn(),
});
function deferred() {
  let resolve!: (shown: string | false) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string | false>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("leaveBox", () => {
  it("leaving a box on its text at focus sends nothing and answers unchanged", () => {
    const rec = focusRecord(); noteFocus(rec, "k", "3");
    const commit = vi.fn<BoxCommit>(() => Promise.resolve("4"));
    expect(leaveBox(rec, "k", "3", commit)).toBe("unchanged");
    expect(commit).not.toHaveBeenCalled();
  });

  it("leaving a changed box commits (value, atFocus)", () => {
    const rec = focusRecord(); noteFocus(rec, "k", "3");
    const commit = vi.fn<BoxCommit>(() => Promise.resolve("4"));
    expect(leaveBox(rec, "k", "4", commit)).toBe("sent");
    expect(commit).toHaveBeenCalledWith("4", "3");
  });

  it("the comparison is the box's own", () => {
    const rec = focusRecord(); noteFocus(rec, "k", " Name ");
    const commit = vi.fn<BoxCommit>(() => Promise.resolve("Name"));
    expect(leaveBox(rec, "k", "Name", commit, trimmedText)).toBe("unchanged");
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("enterBox (R7)", () => {
  it("an unchanged Enter sends nothing", () => {
    const rec = focusRecord(); noteFocus(rec, "k", "3");
    const commit = vi.fn<BoxCommit>(() => Promise.resolve("3"));
    const e = kev("Enter");
    enterBox(e, rec, "k", "3", commit);
    expect(commit).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("another key, and an Enter that ends a composition, do nothing", () => {
    const rec = focusRecord(); noteFocus(rec, "k", "3");
    const commit = vi.fn<BoxCommit>(() => Promise.resolve("4"));
    enterBox(kev("Tab"), rec, "k", "4", commit);
    enterBox(kev("Enter", { isComposing: true }), rec, "k", "4", commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("an accepted Enter commits (value, atFocus), and leaving after it sends nothing while the save is out", () => {
    const rec = focusRecord(); noteFocus(rec, "k", "3");
    const save = deferred();
    const commit = vi.fn<BoxCommit>(() => save.promise);
    enterBox(kev("Enter"), rec, "k", "4", commit);
    expect(commit).toHaveBeenCalledWith("4", "3");
    // The draft holding the sent text stays until the save settles it.
    expect(leaveBox(rec, "k", "4", commit)).toBe("held");
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("after the save lands, the box's shown text is learned, so leaving sends nothing", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "3");
    const save = deferred();
    const commit = vi.fn<BoxCommit>(() => save.promise);
    enterBox(kev("Enter"), rec, "k", "4.0", commit);
    save.resolve("4.00");
    await flush();
    expect(leaveBox(rec, "k", "4.00", commit)).toBe("unchanged");
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("after an accepted Enter, typing the text at focus back and leaving sends it (the record is replaced)", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "3");
    const commit = vi.fn<BoxCommit>((v) => Promise.resolve(v));
    enterBox(kev("Enter"), rec, "k", "5", commit);
    await flush();
    expect(leaveBox(rec, "k", "3", commit)).toBe("sent");
    expect(commit).toHaveBeenLastCalledWith("3", "5");
  });

  it("a save that does not land puts the record back, so the box's stored text sends nothing and the typed text can be sent again", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "3");
    const save = deferred();
    const commit = vi.fn<BoxCommit>(() => save.promise);
    enterBox(kev("Enter"), rec, "k", "4", commit);
    save.resolve(false);
    await flush();
    expect(leaveBox(rec, "k", "3", commit)).toBe("unchanged");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(leaveBox(rec, "k", "4", commit)).toBe("sent");
    expect(commit).toHaveBeenLastCalledWith("4", "3");
  });

  it("a save that rejects is a save that did not land", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "3");
    const save = deferred();
    enterBox(kev("Enter"), rec, "k", "4", () => save.promise);
    save.reject(new Error("down"));
    await flush();
    expect(rec.at.k).toBe("3");
    expect(Object.hasOwn(rec.held, "k")).toBe(false);
  });

  it("a refused Enter (false) leaves the record, so leaving on the restored text sends nothing", () => {
    const rec = focusRecord(); noteFocus(rec, "k", "3");
    const commit = vi.fn<BoxCommit>(() => false);
    enterBox(kev("Enter"), rec, "k", "x", commit);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(leaveBox(rec, "k", "3", commit)).toBe("unchanged");
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("an older Enter's settlement does not overwrite a newer one's record", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "3");
    const first = deferred(); const second = deferred();
    enterBox(kev("Enter"), rec, "k", "4", () => first.promise);
    enterBox(kev("Enter"), rec, "k", "5", () => second.promise);
    first.resolve(false);
    await flush();
    expect(rec.at.k).toBe("5");
    expect(rec.held.k).toBe(2);
    second.resolve("5");
    await flush();
    expect(rec.at.k).toBe("5");
    expect(Object.hasOwn(rec.held, "k")).toBe(false);
  });

  it("a decimal box compares by figure, so its re-spelled figure sends nothing", () => {
    const rec = focusRecord(); noteFocus(rec, "k", "5.00");
    const commit = vi.fn<BoxCommit>(() => Promise.resolve("5"));
    enterBox(kev("Enter"), rec, "k", "5", commit, sameSentValue);
    expect(commit).not.toHaveBeenCalled();
  });

  it("keys are separate boxes", async () => {
    const rec = focusRecord(); noteFocus(rec, "a", "1"); noteFocus(rec, "b", "1");
    const commit = vi.fn<BoxCommit>((v) => Promise.resolve(v));
    enterBox(kev("Enter"), rec, "a", "2", commit);
    await flush();
    expect(leaveBox(rec, "b", "2", commit)).toBe("sent");
  });
});

describe("withoutSettledDraft", () => {
  it("drops the box's draft while it still holds the text the settled save sent", () => {
    expect(withoutSettledDraft({ k: "4", j: "x" }, "k", "4")).toEqual({ j: "x" });
  });
  it("keeps a draft typed since the save was sent (Enter keeps the cursor in the box)", () => {
    const drafts = { k: "45" };
    expect(withoutSettledDraft(drafts, "k", "4")).toBe(drafts);
  });
  it("a box with no draft is left alone", () => {
    const drafts = { j: "x" };
    expect(withoutSettledDraft(drafts, "k", "4")).toBe(drafts);
  });
});

describe("noteFocus", () => {
  it("re-entering a box while its Enter's save is out keeps the sent text as the record", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "3");
    const save = deferred();
    const commit = vi.fn<BoxCommit>(() => save.promise);
    enterBox(kev("Enter"), rec, "k", "4", commit);
    noteFocus(rec, "k", "3");
    expect(leaveBox(rec, "k", "4", commit)).toBe("held");
    expect(commit).toHaveBeenCalledTimes(1);
    save.resolve("4");
    await flush();
    noteFocus(rec, "k", "4");
    expect(rec.at.k).toBe("4");
  });
});

describe("overlapping Enters (Codex on #812)", () => {
  it("when both fail, the record goes back to the text last known stored, never to the first Enter's", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "A");
    const b = deferred(); const c = deferred();
    enterBox(kev("Enter"), rec, "k", "B", () => b.promise);
    enterBox(kev("Enter"), rec, "k", "C", () => c.promise);
    b.resolve(false); c.resolve(false);
    await flush();
    expect(rec.at.k).toBe("A");
    // Typing B back and leaving sends it: B never landed.
    const commit = vi.fn<BoxCommit>(() => Promise.resolve("B"));
    expect(leaveBox(rec, "k", "B", commit)).toBe("sent");
  });
  it("when the first lands and the second fails, the record goes back to the first", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "A");
    const b = deferred(); const c = deferred();
    enterBox(kev("Enter"), rec, "k", "B", () => b.promise);
    enterBox(kev("Enter"), rec, "k", "C", () => c.promise);
    b.resolve("B"); await flush();
    c.resolve(false); await flush();
    expect(rec.at.k).toBe("B");
  });
  it("a landing out of order does not replace a newer landed text", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "A");
    const b = deferred(); const c = deferred(); const d = deferred();
    enterBox(kev("Enter"), rec, "k", "B", () => b.promise);
    enterBox(kev("Enter"), rec, "k", "C", () => c.promise);
    enterBox(kev("Enter"), rec, "k", "D", () => d.promise);
    c.resolve("C"); await flush();
    b.resolve("B"); await flush();
    d.resolve(false); await flush();
    expect(rec.at.k).toBe("C");
  });
});

describe("Enters of the same text (Codex on #812)", () => {
  it("an older Enter of the same text cannot settle a newer one: B, C, then B again, the last failing", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "A");
    const b1 = deferred(); const c = deferred(); const b2 = deferred();
    enterBox(kev("Enter"), rec, "k", "B", () => b1.promise);
    enterBox(kev("Enter"), rec, "k", "C", () => c.promise);
    enterBox(kev("Enter"), rec, "k", "B", () => b2.promise);
    b1.resolve("B"); await flush();
    expect(Object.hasOwn(rec.held, "k")).toBe(true);
    c.resolve("C"); await flush();
    b2.resolve(false); await flush();
    // The server holds C, so the box's record is C and typing B sends it.
    expect(rec.at.k).toBe("C");
    const commit = vi.fn<BoxCommit>(() => Promise.resolve("B"));
    expect(leaveBox(rec, "k", "B", commit)).toBe("sent");
  });
});

describe("a late landing (Codex on #812)", () => {
  it("an older Enter landing after the newest failed moves the record to what it stored", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "A");
    const b = deferred(); const c = deferred();
    enterBox(kev("Enter"), rec, "k", "B", () => b.promise);
    enterBox(kev("Enter"), rec, "k", "C", () => c.promise);
    c.resolve(false); await flush();
    expect(rec.at.k).toBe("A");
    b.resolve("B"); await flush();
    expect(rec.at.k).toBe("B");
    // Typing A back and leaving sends it: the server holds B.
    const commit = vi.fn<BoxCommit>(() => Promise.resolve("A"));
    expect(leaveBox(rec, "k", "A", commit)).toBe("sent");
  });
  it("a late landing older than the box's text at focus changes nothing", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "A");
    const b = deferred(); const c = deferred();
    enterBox(kev("Enter"), rec, "k", "B", () => b.promise);
    enterBox(kev("Enter"), rec, "k", "C", () => c.promise);
    c.resolve(false); await flush();
    noteFocus(rec, "k", "Z");
    b.resolve("B"); await flush();
    expect(rec.at.k).toBe("Z");
  });
});

describe("a landing while a newer Enter is out", () => {
  it("leaves the record to the newer Enter: B, then A, B landing first", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "A");
    const b = deferred(); const a = deferred();
    enterBox(kev("Enter"), rec, "k", "B", () => b.promise);
    enterBox(kev("Enter"), rec, "k", "A", () => a.promise);
    b.resolve("B"); await flush();
    expect(rec.at.k).toBe("A");
    a.resolve("A"); await flush();
    expect(rec.at.k).toBe("A");
  });
});

describe("a save sent on leaving the box is followed too (Codex on #812)", () => {
  it("Enter B, leave with C, re-enter before B settles: once both land the record is C, so typing B sends it", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "A");
    const b = deferred(); const c = deferred();
    enterBox(kev("Enter"), rec, "k", "B", () => b.promise);
    expect(leaveBox(rec, "k", "C", () => c.promise)).toBe("sent");
    noteFocus(rec, "k", "C");
    b.resolve("B"); await flush();
    c.resolve("C"); await flush();
    expect(rec.at.k).toBe("C");
    const commit = vi.fn<BoxCommit>(() => Promise.resolve("B"));
    expect(leaveBox(rec, "k", "B", commit)).toBe("sent");
  });
  it("a save sent on leaving that does not land puts the record back to the stored text", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "A");
    const c = deferred();
    leaveBox(rec, "k", "C", () => c.promise);
    c.resolve(false); await flush();
    expect(rec.at.k).toBe("A");
  });
});

describe("heldText", () => {
  it("is the text a pending save sent, and null once it settles or when none was sent", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "A");
    expect(heldText(rec, "k")).toBe(null);
    const b = deferred();
    enterBox(kev("Enter"), rec, "k", "B", () => b.promise);
    expect(heldText(rec, "k")).toBe("B");
    b.resolve("B"); await flush();
    expect(heldText(rec, "k")).toBe(null);
  });
});

describe("settled", () => {
  it("is called with the sent text when the newest save settles, landed or not, and never for an older one", async () => {
    const rec = focusRecord(); noteFocus(rec, "k", "A");
    const settled = vi.fn();
    const b = deferred(); const c = deferred();
    enterBox(kev("Enter"), rec, "k", "B", () => b.promise, undefined, settled);
    leaveBox(rec, "k", "C", () => c.promise, undefined, settled);
    b.resolve("B"); await flush();
    expect(settled).not.toHaveBeenCalled();
    c.resolve(false); await flush();
    expect(settled.mock.calls).toEqual([["C"]]);
  });
});
