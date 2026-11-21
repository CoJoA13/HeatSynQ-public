import { describe, expect, it } from "vitest";
import {
  NO_FIELD_SAVES, anyNotSaved, checkLineField, cleared, dispatched, failed, fieldKey, fieldView,
  landed, reconciled, refused, restoreIntent, retained, sameSentValue, sameValue, saveIntent, serverValues, settled, typed,
  unansweredStatus, type FieldSave, type FieldSaves, type LineField, type SaveIntent,
} from "@/lib/line-field-saves";

// The save state behind the order hub's Qty and Weight boxes (the quantity corrections design §4):
// what each box shows, whether it reads Saved or Not saved, and whether a blur, an Enter, an
// accepted offer or a Restore sends a request. The leaf is pure, so vitest's "node" environment
// reaches all of it; the Lines section only holds the state and calls these functions.
//
// The scenarios drive the leaf through `section()`, a stand-in that calls the leaf's functions in
// the order the Lines section's handlers call them and decides nothing itself: every decision is a
// call into the leaf. It is not the section. It keeps the save state and the section's two focus
// refs (no page banner, no offered lines), and it differs from the section's own handlers in three
// places:
//
// - It dispatches the text as it was typed. The section dispatches what its request carries:
//   String(Number(trimmed)) for a quantity and the trimmed text for a weight, so "040" goes out,
//   and is shown, as 40.
// - Its counter is bumped per request. The section's is also bumped by a client-side refusal.
// - It is told how a request failed: `fails` is a refusal the server answered, `loses` is a request
//   that got no answer. The section reads that off the error it caught.
//
// So a scenario here is proof about the leaf, and not about what the section's handlers send:
// lines-section-wiring.test.ts lifts the real handlers out of LinesSection.tsx and runs them
// against this leaf. Each rule and each guard below is proven by changing it and watching the
// scenario that names it go red.

type Line = { id: string; qty: number; weight: number };
const LEAD: Line = { id: "L1", qty: 32, weight: 60 };
const QTY = fieldKey("L1", "qty");
const WEIGHT = fieldKey("L1", "weight");
const BELOW_SHIPPED = "Lead (ACME · P-100): cannot reduce qty below 30 already shipped";
const NOT_WHOLE = "Lead: quantity must be a whole number of at least 1.";
/** What the browser's fetch rejects with when no response arrives. */
const NO_ANSWER = "Failed to fetch";

/** One Lines section over the leaf alone. */
function section(start: readonly Line[] = [LEAD]) {
  let lines = start;
  let saves: FieldSaves = NO_FIELD_SAVES;
  let attempts = 0; // one counter, never reset; bumped per request here (the section's also counts a client-side refusal)
  let focused = ""; // the section's `focusedValue` ref: the focused box's text at focus
  let focusedKey: string | null = null; // the section's `focusedKey` ref: which box has focus
  const requests: { attempt: number; key: string; text: string }[] = [];
  const server = () => serverValues(lines);
  const view = (key: string) => fieldView(saves.get(key), server().get(key) ?? "");

  /** The section's one request path: refuse the text on the client, or send it as the next attempt. */
  function checkAndSend(key: string, text: string): "send" | "refused" {
    const field: LineField = key.endsWith(":qty") ? "qty" : "weight";
    const message = checkLineField(field, text, "Lead");
    if (message !== null) { saves = refused(saves, key, text, message); return "refused"; }
    attempts += 1;
    saves = dispatched(saves, key, text, attempts);
    requests.push({ attempt: attempts, key, text });
    return "send";
  }
  function commit(key: string, text: string, atFocus: string | null): SaveIntent | "refused" {
    const intent = saveIntent({ save: saves.get(key), server: server().get(key) ?? "", text, atFocus });
    if (intent === "settle") saves = settled(saves, key);
    if (intent !== "send") return intent;
    return checkAndSend(key, text);
  }
  /** The fresh order is on screen; the `[lines]` effect has not run yet. */
  function renders(next: readonly Line[]) { lines = next; }
  /** The `[lines]` effect. */
  function reconcile() { saves = reconciled(saves, server()); }
  /** The request answered 2xx. With `payload` the page applied the fresh order first; without, a
   *  newer response had already been applied, so the page dropped this one and `lines` is unchanged. */
  function answers(attempt: number, payload?: readonly Line[]) {
    if (payload) renders(payload);
    saves = landed(saves, requests[attempt - 1].key, attempt);
  }

  return {
    requests, view, renders, reconcile, answers,
    saves: () => saves,
    notSaved: () => anyNotSaved(saves, server()),
    focus(key: string) { focusedKey = key; focused = view(key).text; },
    /** Replace the box's text, as a run of keystrokes ends up. */
    type(key: string, text: string) { saves = typed(saves, key, text); },
    blur(key: string) {
      if (focusedKey === key) focusedKey = null;
      return commit(key, view(key).text, focused);
    },
    enter(key: string) { focused = view(key).text; return commit(key, focused, null); },
    /** An accepted offer: the figure goes straight to a save. Called after `focus(key)` with no
     *  blur between, it is the pointer's Use: focus stays in the box, and the figure is recorded as
     *  the box's text at focus, as the section does. */
    use(key: string, text: string) {
      if (focusedKey === key) focused = text;
      return commit(key, text, null);
    },
    /** The Restore control: local, or a save of the stored value, as the leaf says. Called after
     *  `focus(key)` with no blur between, it is the pointer's Restore: focus stays in the box, and
     *  the stored value it puts there is recorded as the box's text at focus, as the section does. */
    restore(key: string): "clear" | "send" | "refused" {
      if (focusedKey === key) focused = server().get(key) ?? "";
      if (restoreIntent(saves.get(key)) === "clear") { saves = cleared(saves, key); return "clear"; }
      return checkAndSend(key, server().get(key) ?? "");
    },
    lands(attempt: number, payload: readonly Line[]) { answers(attempt, payload); reconcile(); },
    /** The server answered and refused: nothing was written. */
    fails(attempt: number, message: string) { saves = failed(saves, requests[attempt - 1].key, attempt, message); },
    /** No answer the page can trust: the connection dropped, the server answered 5xx, or (#547) it
     *  answered 2xx and its body could not be read. The write may have been committed (after a 2xx,
     *  it was). */
    loses(attempt: number, message: string = NO_ANSWER) {
      saves = failed(saves, requests[attempt - 1].key, attempt, message, true);
    },
    /** A fresh order from anywhere: another section's save, a reload. */
    payload(next: readonly Line[]) { renders(next); reconcile(); },
  };
}

const quiet = (text: string) => ({ text, mark: null, message: null, saving: false });
const savedView = (text: string) => ({ text, mark: "saved", message: null, saving: false });

describe("scenarios: a save that lands", () => {
  it("a blur save reads saving, then Saved, and the draft goes once the server shows the value", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40");
    expect(s.view(QTY)).toEqual(quiet("40"));
    expect(s.blur(QTY)).toBe("send");
    expect(s.requests).toEqual([{ attempt: 1, key: QTY, text: "40" }]);
    expect(s.view(QTY)).toEqual({ text: "40", mark: null, message: null, saving: true });
    s.lands(1, [{ ...LEAD, qty: 40 }]);
    expect(s.view(QTY)).toEqual(savedView("40"));
    expect(s.saves().get(QTY)).toEqual({ draft: null, pending: null, outcome: { kind: "saved", text: "40" } });
    expect(s.notSaved()).toBe(false);
  });

  it("an Enter save then a blur keeps Saved, at each instant the blur can arrive", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40");
    expect(s.enter(QTY)).toBe("send");
    // In flight: this value is already out (rule 1).
    expect(s.blur(QTY)).toBe("skip");
    // Answered and the fresh order on screen, the effect not yet run: the draft is still there and
    // is the server's value. Nothing changed since focus, so nothing is settled either (rule 3
    // comes before rule 4).
    s.answers(1, [{ ...LEAD, qty: 40 }]);
    const answered = s.saves();
    expect(s.blur(QTY)).toBe("skip");
    expect(s.saves()).toBe(answered);
    // Reconciled: no draft, and the box shows the server's value (rule 2).
    s.reconcile();
    const settledDown = s.saves();
    expect(s.blur(QTY)).toBe("skip");
    expect(s.saves()).toBe(settledDown);
    expect(s.requests).toHaveLength(1);
    expect(s.view(QTY)).toEqual(savedView("40"));
  });

  it("a second Enter on a Saved field keeps it and sends nothing", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.enter(QTY);
    s.lands(1, [{ ...LEAD, qty: 40 }]);
    const before = s.saves();
    expect(s.enter(QTY)).toBe("skip");
    expect(s.saves()).toBe(before);
    expect(s.view(QTY)).toEqual(savedView("40"));
    expect(s.requests).toHaveLength(1);
  });

  it("a second Enter before the effect has run settles the draft and keeps Saved", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.enter(QTY);
    s.answers(1, [{ ...LEAD, qty: 40 }]);
    expect(s.enter(QTY)).toBe("settle");
    expect(s.saves().get(QTY)).toEqual({ draft: null, pending: null, outcome: { kind: "saved", text: "40" } });
    expect(s.view(QTY)).toEqual(savedView("40"));
    expect(s.requests).toHaveLength(1);
  });

  it("tabbing through a Saved field, or an untouched one, changes nothing", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.blur(QTY);
    s.lands(1, [{ ...LEAD, qty: 40 }]);
    const before = s.saves();
    s.focus(WEIGHT);
    expect(s.blur(WEIGHT)).toBe("skip");
    s.focus(QTY);
    expect(s.blur(QTY)).toBe("skip");
    expect(s.saves()).toBe(before);
    expect(s.view(QTY)).toEqual(savedView("40"));
    expect(s.requests).toHaveLength(1);
  });

  it("Enter on a field nobody touched sends nothing", () => {
    const s = section();
    s.focus(WEIGHT);
    expect(s.enter(WEIGHT)).toBe("skip");
    expect(s.saves()).toBe(NO_FIELD_SAVES);
  });

  it('"48.50" saved over a server 48.5 still reads Saved', () => {
    const s = section();
    s.focus(WEIGHT); s.type(WEIGHT, "48.50");
    expect(s.blur(WEIGHT)).toBe("send");
    expect(s.requests[0].text).toBe("48.50");
    s.answers(1, [{ ...LEAD, weight: 48.5 }]);
    expect(s.view(WEIGHT)).toEqual(savedView("48.50"));
    s.focus(WEIGHT); // focus arrives while the box still shows the typed "48.50"
    s.reconcile();
    expect(s.view(WEIGHT)).toEqual(savedView("48.5"));
    // "48.5" is not the at-focus "48.50", and there is still nothing to send or settle (rule 2).
    expect(s.blur(WEIGHT)).toBe("skip");
    expect(s.view(WEIGHT)).toEqual(savedView("48.5"));
    expect(s.requests).toHaveLength(1);
  });

  it("a value numerically equal to the stored one sends nothing and the draft goes", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "32.0");
    expect(s.blur(QTY)).toBe("settle");
    expect(s.saves().has(QTY)).toBe(false);
    expect(s.view(QTY)).toEqual(quiet("32"));
    expect(s.requests).toHaveLength(0);
  });

  it("a value typed and typed back within one focus leaves nothing behind", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "33"); s.type(QTY, "32");
    expect(s.blur(QTY)).toBe("settle");
    expect(s.saves().has(QTY)).toBe(false);
    expect(s.requests).toHaveLength(0);
  });

  it("a payload that changes the value under a focused, untouched box sends nothing on blur", () => {
    const s = section();
    s.focus(QTY); // the at-focus text is "32"
    s.payload([{ ...LEAD, qty: 40 }]);
    expect(s.blur(QTY)).toBe("skip");
    expect(s.saves()).toBe(NO_FIELD_SAVES);
    expect(s.view(QTY)).toEqual(quiet("40"));
  });

  it("after such a payload the earlier value typed back is sent: the text at focus is stale, and a draft with no mark is never skipped", () => {
    const s = section();
    s.focus(QTY); // the at-focus text is "32"
    s.payload([{ ...LEAD, qty: 40 }]); // the box now shows 40, and no focus event says so
    s.type(QTY, "32");
    // 32 is what the box held at focus, and it is not what the server holds any more.
    expect(s.blur(QTY)).toBe("send");
    expect(s.requests).toEqual([{ attempt: 1, key: QTY, text: "32" }]);
  });

  it("a quantity landing leaves text being typed into the weight box alone", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.blur(QTY);
    s.focus(WEIGHT); s.type(WEIGHT, "5");
    s.lands(1, [{ ...LEAD, qty: 40 }]);
    expect(s.view(WEIGHT)).toEqual(quiet("5"));
    expect(s.view(QTY)).toEqual(savedView("40"));
  });
});

describe("scenarios: a second value while a save is in flight", () => {
  it("a correction typed back to the stored value is sent, and the first attempt's answer is ignored", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40");
    expect(s.blur(QTY)).toBe("send");
    s.focus(QTY); s.type(QTY, "32");
    expect(s.blur(QTY)).toBe("send"); // rule 1: "32" is the stored value, and it still goes out
    expect(s.requests.map((r) => r.text)).toEqual(["40", "32"]);
    // The first request answers first. The page shows its order (qty 40); the leaf ignores its
    // completion, and the effect leaves the entry alone while the correction is out.
    const before = s.saves();
    s.answers(1, [{ ...LEAD, qty: 40 }]);
    s.reconcile();
    expect(s.saves()).toBe(before);
    expect(s.view(QTY)).toEqual({ text: "32", mark: null, message: null, saving: true });
    s.lands(2, [{ ...LEAD }]);
    expect(s.view(QTY)).toEqual(savedView("32"));
  });

  it("when the first attempt is refused instead, the abandoned value does not come back as Not saved", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "20"); s.blur(QTY);
    s.focus(QTY); s.type(QTY, "32"); s.blur(QTY);
    const before = s.saves();
    s.fails(1, BELOW_SHIPPED);
    expect(s.saves()).toBe(before);
    expect(s.view(QTY)).toEqual({ text: "32", mark: null, message: null, saving: true });
    expect(s.notSaved()).toBe(false);
  });

  it("the value already in flight is not sent again, however it is written", () => {
    const s = section();
    s.focus(WEIGHT); s.type(WEIGHT, "48.5");
    expect(s.enter(WEIGHT)).toBe("send");
    expect(s.enter(WEIGHT)).toBe("skip");
    s.type(WEIGHT, "48.50");
    expect(s.blur(WEIGHT)).toBe("skip");
    expect(s.use(WEIGHT, "48.5")).toBe("skip");
    expect(s.requests).toHaveLength(1);
    // "48.50" was typed after "48.5" went out. It is the value in flight, which is why nothing more
    // was sent, but it is not the text that was sent: the landing puts no mark on it and the
    // payload does not swap it for "48.5" (text typed since a request is never replaced).
    s.lands(1, [{ ...LEAD, weight: 48.5 }]);
    expect(s.view(WEIGHT)).toEqual(quiet("48.50"));
    // It is the stored value in another spelling, so the next blur settles it and sends nothing.
    expect(s.blur(WEIGHT)).toBe("settle");
    expect(s.view(WEIGHT)).toEqual(quiet("48.5"));
    expect(s.requests).toHaveLength(1);
  });

  it("typing on while a save is in flight: the landing puts no mark on the newer text", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.blur(QTY);
    s.focus(QTY); s.type(QTY, "45");
    s.lands(1, [{ ...LEAD, qty: 40 }]);
    expect(s.saves().get(QTY)).toEqual({ draft: "45", pending: null, outcome: null });
    expect(s.view(QTY)).toEqual(quiet("45"));
    expect(s.blur(QTY)).toBe("send");
    expect(s.requests.map((r) => r.text)).toEqual(["40", "45"]);
  });

  it('partly typed text is not the value in flight: "4." on the way to 4.5 survives the landing of 4', () => {
    const s = section();
    s.focus(WEIGHT); s.type(WEIGHT, "4");
    expect(s.enter(WEIGHT)).toBe("send");
    s.type(WEIGHT, "4.");
    s.lands(1, [{ ...LEAD, weight: 4 }]);
    expect(s.view(WEIGHT)).toEqual(quiet("4."));
  });

  it('a complete spelling typed on is not the text in flight either: "40.0" on the way to 40.05 survives the landing of 40', () => {
    const s = section();
    s.focus(WEIGHT); s.type(WEIGHT, "40");
    expect(s.enter(WEIGHT)).toBe("send"); // Enter keeps focus in the box
    s.type(WEIGHT, "40.0"); // one key short of "40.05", and numerically the 40 that is out
    // The save of 40 answers and the page shows its order. The box holds text typed since the
    // request went out, so the landing puts no mark on it.
    s.answers(1, [{ ...LEAD, weight: 40 }]);
    expect(s.saves().get(WEIGHT)).toEqual({ draft: "40.0", pending: null, outcome: null });
    expect(s.view(WEIGHT)).toEqual(quiet("40.0"));
    // The payload leaves a bare draft alone: the box is not swapped to "40" under the cursor.
    s.reconcile();
    expect(s.view(WEIGHT)).toEqual(quiet("40.0"));
    // The next key lands on the text the operator sees, and the blur sends what was typed.
    s.type(WEIGHT, "40.05");
    expect(s.blur(WEIGHT)).toBe("send");
    expect(s.requests.map((r) => r.text)).toEqual(["40", "40.05"]);
  });

  it('a blur at the respelled value, after the landing, settles it: "40.0" over a stored 40 sends nothing', () => {
    const s = section();
    s.focus(WEIGHT); s.type(WEIGHT, "40");
    expect(s.enter(WEIGHT)).toBe("send");
    s.type(WEIGHT, "40.0");
    s.lands(1, [{ ...LEAD, weight: 40 }]);
    expect(s.view(WEIGHT)).toEqual(quiet("40.0"));
    expect(s.blur(WEIGHT)).toBe("settle");
    expect(s.saves().has(WEIGHT)).toBe(false);
    expect(s.view(WEIGHT)).toEqual(quiet("40"));
    expect(s.requests).toHaveLength(1);
  });

  it('the "4o" case: an older attempt landing leaves a newer client-side refusal in place', () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40");
    expect(s.blur(QTY)).toBe("send");
    s.focus(QTY); s.type(QTY, "4o");
    expect(s.blur(QTY)).toBe("refused");
    expect(s.requests).toHaveLength(1);
    expect(s.view(QTY)).toEqual({ text: "4o", mark: "not-saved", message: NOT_WHOLE, saving: true });
    s.lands(1, [{ ...LEAD, qty: 40 }]);
    expect(s.view(QTY)).toEqual({ text: "4o", mark: "not-saved", message: NOT_WHOLE, saving: false });
    expect(s.notSaved()).toBe(true);
    s.restore(QTY);
    expect(s.view(QTY)).toEqual(quiet("40"));
    expect(s.notSaved()).toBe(false);
  });

  it("a refusal corrected back to the value in flight stops reading Not saved at once", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.blur(QTY);
    s.focus(QTY); s.type(QTY, "4o");
    expect(s.blur(QTY)).toBe("refused");
    s.focus(QTY); s.type(QTY, "40");
    expect(s.view(QTY)).toEqual({ text: "40", mark: null, message: null, saving: true });
    expect(s.blur(QTY)).toBe("skip");
    s.lands(1, [{ ...LEAD, qty: 40 }]);
    expect(s.view(QTY)).toEqual(savedView("40"));
  });

  it("attempt numbers never repeat, so a slow old answer cannot land on a newer entry", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.blur(QTY); // attempt 1, slow
    s.focus(QTY); s.type(QTY, "45"); s.blur(QTY); // attempt 2
    s.fails(2, BELOW_SHIPPED);
    s.restore(QTY);
    s.focus(QTY); s.type(QTY, "50");
    expect(s.blur(QTY)).toBe("send");
    expect(s.requests.map((r) => r.attempt)).toEqual([1, 2, 3]);
    const before = s.saves();
    s.answers(1, [{ ...LEAD, qty: 40 }]);
    s.reconcile();
    expect(s.saves()).toBe(before);
    expect(s.view(QTY)).toEqual({ text: "50", mark: null, message: null, saving: true });
  });

  it("an older request that outlives a refused newer one: after Restore the box follows the server when it lands", () => {
    const s = section();
    s.focus(WEIGHT); s.type(WEIGHT, "48.5"); s.blur(WEIGHT); // attempt 1, slow
    s.focus(WEIGHT); s.type(WEIGHT, "9"); s.blur(WEIGHT); // attempt 2
    s.fails(2, "Lead (ACME · P-100): cannot reduce net weight below 10 lb already shipped");
    expect(s.view(WEIGHT).mark).toBe("not-saved");
    s.restore(WEIGHT);
    expect(s.view(WEIGHT)).toEqual(quiet("60"));
    s.lands(1, [{ ...LEAD, weight: 48.5 }]);
    expect(s.saves().has(WEIGHT)).toBe(false);
    expect(s.view(WEIGHT)).toEqual(quiet("48.5"));
  });
});

describe("scenarios: a value that is not saved", () => {
  it("a refused value reads Not saved; tabbing through sends nothing; Enter retries", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "20");
    expect(s.blur(QTY)).toBe("send");
    s.fails(1, BELOW_SHIPPED);
    expect(s.view(QTY)).toEqual({ text: "20", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
    expect(s.notSaved()).toBe(true);
    s.focus(QTY);
    expect(s.blur(QTY)).toBe("skip"); // rule 3
    expect(s.requests).toHaveLength(1);
    s.focus(QTY);
    expect(s.enter(QTY)).toBe("send"); // rule 5: Enter carries no at-focus text
    expect(s.requests.map((r) => r.text)).toEqual(["20", "20"]);
    // The retry is out: still Not saved, and still counted, until it settles.
    expect(s.view(QTY)).toEqual({ text: "20", mark: "not-saved", message: BELOW_SHIPPED, saving: true });
    expect(s.notSaved()).toBe(true);
    s.lands(2, [{ ...LEAD, qty: 20 }]);
    expect(s.view(QTY)).toEqual(savedView("20"));
    expect(s.notSaved()).toBe(false);
  });

  it("an Enter save that fails, then a blur, sends nothing more", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "20");
    expect(s.enter(QTY)).toBe("send");
    s.fails(1, BELOW_SHIPPED);
    expect(s.blur(QTY)).toBe("skip");
    expect(s.requests).toHaveLength(1);
    expect(s.view(QTY).mark).toBe("not-saved");
  });

  it("a retry that lands after the text moved on leaves no Not saved mark behind", () => {
    const BELOW_WEIGHT = "Lead (ACME · P-100): cannot reduce net weight below 10 lb already shipped";
    const s = section();
    s.focus(WEIGHT); s.type(WEIGHT, "5");
    expect(s.enter(WEIGHT)).toBe("send");
    s.fails(1, BELOW_WEIGHT);
    s.type(WEIGHT, "48");
    expect(s.view(WEIGHT).mark).toBe("not-saved"); // nothing in flight: typing keeps the mark
    expect(s.enter(WEIGHT)).toBe("send");
    expect(s.view(WEIGHT)).toEqual({ text: "48", mark: "not-saved", message: BELOW_WEIGHT, saving: true });
    s.type(WEIGHT, "480"); // typing on while the retry is out: the old refusal is not about this text
    expect(s.view(WEIGHT)).toEqual({ text: "480", mark: null, message: null, saving: true });
    expect(s.notSaved()).toBe(false);
    s.lands(2, [{ ...LEAD, weight: 48 }]);
    expect(s.view(WEIGHT)).toEqual(quiet("480"));
    // Back to "48", which is also the at-focus text Enter left. A draft with no mark is not
    // skipped, and it is the stored value now, so it settles.
    s.type(WEIGHT, "48");
    expect(s.blur(WEIGHT)).toBe("settle");
    expect(s.view(WEIGHT)).toEqual(quiet("48"));
    expect(s.notSaved()).toBe(false);
    expect(s.requests).toHaveLength(2);
  });

  it("a retry that fails after the text moved on reads Not saved on the text in the box", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "20"); s.enter(QTY);
    s.loses(1);
    s.enter(QTY);
    s.type(QTY, "25");
    s.fails(2, BELOW_SHIPPED);
    expect(s.view(QTY)).toEqual({ text: "25", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
    expect(s.notSaved()).toBe(true);
  });

  it("a retry that fails again shows the newer reason", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "20"); s.blur(QTY);
    s.loses(1);
    s.enter(QTY);
    s.fails(2, BELOW_SHIPPED);
    expect(s.view(QTY)).toEqual({ text: "20", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
  });

  it("retyping the stored value over a Not saved field settles it: no request, no mark, nothing counted", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "20"); s.blur(QTY);
    s.fails(1, BELOW_SHIPPED);
    s.focus(QTY); s.type(QTY, "32");
    expect(s.view(QTY).mark).toBe("not-saved"); // typing alone settles nothing
    expect(s.blur(QTY)).toBe("settle"); // rule 4
    expect(s.saves().has(QTY)).toBe(false);
    expect(s.view(QTY)).toEqual(quiet("32"));
    expect(s.notSaved()).toBe(false);
    expect(s.requests).toHaveLength(1);
  });

  it("a value the client refuses sends no request and reads Not saved until a good value lands", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "4o");
    expect(s.blur(QTY)).toBe("refused");
    expect(s.requests).toHaveLength(0);
    expect(s.view(QTY)).toEqual({ text: "4o", mark: "not-saved", message: NOT_WHOLE, saving: false });
    expect(s.notSaved()).toBe(true);
    const before = s.saves();
    expect(s.enter(QTY)).toBe("refused"); // Enter tries again and is refused again
    expect(s.saves()).toBe(before);
    s.type(QTY, "40");
    expect(s.view(QTY).mark).toBe("not-saved");
    expect(s.blur(QTY)).toBe("send");
    s.lands(1, [{ ...LEAD, qty: 40 }]);
    expect(s.view(QTY)).toEqual(savedView("40"));
    expect(s.notSaved()).toBe(false);
  });

  it("the same refused text typed again after Restore is not mistaken for unchanged since focus", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "20"); s.blur(QTY);
    s.fails(1, BELOW_SHIPPED);
    s.focus(QTY); // the at-focus text is "20"
    s.restore(QTY); // the box now shows 32, with no focus event; Restore records 32 as its text at focus
    s.type(QTY, "20");
    expect(s.blur(QTY)).toBe("send");
    s.fails(2, BELOW_SHIPPED);
    expect(s.view(QTY)).toEqual({ text: "20", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
    // The same with a value the client refuses, after an Enter left it as the at-focus text.
    s.focus(WEIGHT); s.type(WEIGHT, "0");
    expect(s.enter(WEIGHT)).toBe("refused");
    s.restore(WEIGHT);
    s.type(WEIGHT, "0");
    expect(s.blur(WEIGHT)).toBe("refused");
    expect(s.view(WEIGHT).mark).toBe("not-saved");
    expect(s.notSaved()).toBe(true);
  });

  it("Restore after retyping a Not saved field restores, and the blur that follows sends nothing", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "20"); s.blur(QTY);
    s.fails(1, BELOW_SHIPPED);
    s.focus(QTY); s.type(QTY, "31");
    s.restore(QTY); // the button keeps focus in the box, so no blur came first
    expect(s.view(QTY)).toEqual(quiet("32"));
    expect(s.blur(QTY)).toBe("skip");
    expect(s.requests).toHaveLength(1);
    expect(s.saves().has(QTY)).toBe(false);
  });

  it("Restore drops the entry: the box shows the stored value and nothing is counted", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "20"); s.blur(QTY);
    s.fails(1, BELOW_SHIPPED);
    s.restore(QTY);
    expect(s.saves().has(QTY)).toBe(false);
    expect(s.view(QTY)).toEqual(quiet("32"));
    expect(s.notSaved()).toBe(false);
  });

  it("a response lost after the write committed stays Not saved when a payload shows the value: a save of the box that lands ends it, a payload never does", () => {
    const lost = { text: "40", mark: "not-saved", message: NO_ANSWER, saving: false };
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.blur(QTY);
    s.loses(1);
    expect(s.view(QTY)).toEqual(lost);
    // The write did land, and another section's save brings an order that shows it. The page
    // cannot know this order was read after the lost write: it would look the same had it been
    // the answer to a request sent before a later save of this box.
    const before = s.saves();
    s.payload([{ ...LEAD, qty: 40 }]);
    expect(s.saves()).toBe(before);
    expect(s.view(QTY)).toEqual(lost);
    expect(s.notSaved()).toBe(true);
    // Tabbing through it sends nothing (rule 3). Enter sends the box's text, the stored value by
    // now (rule 4), and that save landing is what ends Not saved.
    s.focus(QTY);
    expect(s.blur(QTY)).toBe("skip");
    expect(s.enter(QTY)).toBe("send");
    expect(s.requests.map((r) => r.text)).toEqual(["40", "40"]);
    s.lands(2, [{ ...LEAD, qty: 40 }]);
    expect(s.view(QTY)).toEqual(savedView("40"));
    expect(s.notSaved()).toBe(false);
  });

  it('a payload leaves a Not saved box alone while it is retyped through the stored value: "40.0" on the way to 40.05', () => {
    const BELOW_WEIGHT = "Lead (ACME · P-100): cannot reduce net weight below 30 lb already shipped";
    const holds40: Line = { ...LEAD, weight: 40 };
    const s = section([holds40]);
    s.focus(WEIGHT); s.type(WEIGHT, "20");
    expect(s.blur(WEIGHT)).toBe("send");
    s.fails(1, BELOW_WEIGHT);
    s.focus(WEIGHT); s.type(WEIGHT, "40.0"); // one key short of "40.05", and numerically the stored 40
    const retyping = { text: "40.0", mark: "not-saved", message: BELOW_WEIGHT, saving: false };
    expect(s.view(WEIGHT)).toEqual(retyping);
    // Another section's save answers and the page applies its order. This line still weighs 40, and
    // the box is not swapped to "40" under the cursor: its text is not the server's text.
    const before = s.saves();
    s.payload([{ ...holds40, qty: 33 }]);
    expect(s.saves()).toBe(before);
    expect(s.view(WEIGHT)).toEqual(retyping);
    s.type(WEIGHT, "40.05");
    expect(s.blur(WEIGHT)).toBe("send");
    expect(s.requests.map((r) => r.text)).toEqual(["20", "40.05"]);
  });

  it('a lost response for a weight typed as "48.50" keeps Not saved when a payload shows 48.5, until Enter or Restore saves it', () => {
    const lost = { text: "48.50", mark: "not-saved", message: NO_ANSWER, saving: false };
    const typedAndLost = () => {
      const s = section();
      s.focus(WEIGHT); s.type(WEIGHT, "48.50");
      expect(s.blur(WEIGHT)).toBe("send");
      s.loses(1);
      s.payload([{ ...LEAD, weight: 48.5 }]); // the write did land, and the server writes it "48.5"
      return s;
    };
    // The box records a save the server did not answer, so no payload settles it, in the server's
    // spelling or in its own: the mark stays and the section still counts as unsaved work.
    const s = typedAndLost();
    expect(s.view(WEIGHT)).toEqual(lost);
    expect(s.notSaved()).toBe(true);
    // Tabbing through it sends nothing and clears nothing (rule 3).
    s.focus(WEIGHT);
    expect(s.blur(WEIGHT)).toBe("skip");
    expect(s.view(WEIGHT)).toEqual(lost);
    // Enter finds the stored value in the box. The save that put it there was never answered, so
    // it is sent again and not settled (rule 4), and the answer is what ends Not saved.
    expect(s.enter(WEIGHT)).toBe("send");
    expect(s.requests.map((r) => r.text)).toEqual(["48.50", "48.50"]);
    expect(s.view(WEIGHT)).toEqual({ ...lost, saving: true });
    s.lands(2, [{ ...LEAD, weight: 48.5 }]);
    expect(s.view(WEIGHT)).toEqual(savedView("48.5"));
    expect(s.notSaved()).toBe(false);
    // Restore saves the stored value, as the server writes it.
    const r = typedAndLost();
    expect(r.restore(WEIGHT)).toBe("send");
    expect(r.requests.map((q) => q.text)).toEqual(["48.50", "48.5"]);
    r.lands(2, [{ ...LEAD, weight: 48.5 }]);
    expect(r.view(WEIGHT)).toEqual(savedView("48.5"));
    expect(r.notSaved()).toBe(false);
  });

  it('the same weight when the server answered and refused it: Enter settles the stored value and Restore clears, with no request', () => {
    const typedAndRefused = () => {
      const s = section();
      s.focus(WEIGHT); s.type(WEIGHT, "48.50");
      expect(s.blur(WEIGHT)).toBe("send");
      s.fails(1, "Not signed in"); // a 401: the session had expired, and nothing was written
      s.payload([{ ...LEAD, weight: 48.5 }]); // someone else's save put 48.5 there since
      return s;
    };
    // The refusal was an answer: the server wrote nothing for this box, so what the page shows as
    // stored is what the server holds, and nothing needs to be sent to make the two agree. The
    // mark is still there after the payload for another reason, the price of comparing text: the
    // box cannot tell "48.50" over a stored 48.5 from text on its way somewhere else.
    const s = typedAndRefused();
    expect(s.view(WEIGHT).mark).toBe("not-saved");
    expect(s.enter(WEIGHT)).toBe("settle");
    expect(s.saves().has(WEIGHT)).toBe(false);
    expect(s.view(WEIGHT)).toEqual(quiet("48.5"));
    expect(s.requests).toHaveLength(1);
    const r = typedAndRefused();
    expect(r.restore(WEIGHT)).toBe("clear");
    expect(r.view(WEIGHT)).toEqual(quiet("48.5"));
    expect(r.notSaved()).toBe(false);
    expect(r.requests).toHaveLength(1);
  });

  it("a removed line stops counting before the effect runs, and its entries go when it does", () => {
    const rider: Line = { id: "L2", qty: 5, weight: 9 };
    const riderQty = fieldKey("L2", "qty");
    const riderWeight = fieldKey("L2", "weight");
    const s = section([LEAD, rider]);
    s.focus(riderWeight); s.type(riderWeight, "0");
    expect(s.blur(riderWeight)).toBe("refused");
    s.focus(riderQty); s.type(riderQty, "7");
    expect(s.blur(riderQty)).toBe("send");
    expect(s.notSaved()).toBe(true);
    s.renders([LEAD]);
    expect(s.saves().has(riderWeight)).toBe(true);
    expect(s.notSaved()).toBe(false);
    s.reconcile();
    expect(s.saves().size).toBe(0);
    // The removed line's own request answers late, either way.
    const before = s.saves();
    s.answers(1);
    s.fails(1, "Order line not found");
    expect(s.saves()).toBe(before);
  });

  it("a removed line's request that gets no answer leaves an entry no box shows: it is not counted, and the next payload drops it", () => {
    const rider: Line = { id: "L2", qty: 5, weight: 9 };
    const riderQty = fieldKey("L2", "qty");
    const s = section([LEAD, rider]);
    s.focus(riderQty); s.type(riderQty, "7");
    expect(s.blur(riderQty)).toBe("send");
    s.payload([LEAD]); // the line is removed while its save is out
    expect(s.saves().size).toBe(0);
    // `failed` is not told which lines the order still has, so it records the failure as it would
    // for a box whose entry Restore had cleared.
    s.loses(1);
    expect(s.saves().get(riderQty)).toEqual({ draft: null, pending: null, outcome: { kind: "failed", message: NO_ANSWER }, unanswered: true });
    expect(s.notSaved()).toBe(false);
    s.payload([{ ...LEAD, weight: 61 }]);
    expect(s.saves().size).toBe(0);
  });
});

// A save that got no answer may have been committed, so the value the page shows as stored may not
// be what the server holds. Putting that value back in the box without sending anything would leave
// the screen and the order disagreeing with no mark to say so. So Restore SAVES it (owner ruling
// 2026-10-07), and so does the other way back to the stored value, typing it and leaving the box
// (decided without the owner, for the same reason).
describe("scenarios: a save the server did not answer", () => {
  const notSaved = (text: string, message: string, saving = false) => ({ text, mark: "not-saved", message, saving });
  /** Quantity 40 typed over a stored 32 and sent; no answer comes back. The page still shows 32 as
   *  the stored value, and whether the server wrote 40 is not known. */
  function lost() {
    const s = section();
    s.focus(QTY); s.type(QTY, "40");
    expect(s.blur(QTY)).toBe("send");
    s.loses(1);
    return s;
  }

  it("reads Not saved, counts as unsaved work, and the box records that a save of it went unanswered", () => {
    const s = lost();
    expect(s.view(QTY)).toEqual(notSaved("40", NO_ANSWER));
    expect(s.saves().get(QTY)).toEqual({ draft: "40", pending: null, outcome: { kind: "failed", message: NO_ANSWER }, unanswered: true });
    expect(s.notSaved()).toBe(true);
  });

  it("Restore saves the stored value: one request, Not saved over the stored value while it is out, Saved when it lands", () => {
    const s = lost();
    expect(s.restore(QTY)).toBe("send");
    expect(s.requests).toEqual([{ attempt: 1, key: QTY, text: "40" }, { attempt: 2, key: QTY, text: "32" }]);
    // While it is out the box shows the stored value, still marked and still counted: the print
    // gate stays closed until the answer says the order and the screen agree.
    expect(s.view(QTY)).toEqual(notSaved("32", NO_ANSWER, true));
    expect(s.notSaved()).toBe(true);
    s.lands(2, [{ ...LEAD }]);
    expect(s.view(QTY)).toEqual(savedView("32"));
    expect(s.saves().get(QTY)).toEqual({ draft: null, pending: null, outcome: { kind: "saved", text: "32" } });
    expect(s.notSaved()).toBe(false);
  });

  it("the stored value typed back and left is sent, not settled", () => {
    const s = lost();
    s.focus(QTY); s.type(QTY, "32");
    // Typing keeps the mark, and the box's record that a save of it went unanswered.
    expect(s.view(QTY)).toEqual(notSaved("32", NO_ANSWER));
    expect(s.blur(QTY)).toBe("send"); // rule 4
    expect(s.requests.map((r) => r.text)).toEqual(["40", "32"]);
    expect(s.view(QTY)).toEqual(notSaved("32", NO_ANSWER, true));
    expect(s.notSaved()).toBe(true);
    s.lands(2, [{ ...LEAD }]);
    expect(s.view(QTY)).toEqual(savedView("32"));
    expect(s.notSaved()).toBe(false);
  });

  it("the stored value in another spelling, and on Enter, is sent too", () => {
    const s = lost();
    s.focus(QTY); s.type(QTY, "32.0");
    expect(s.enter(QTY)).toBe("send");
    expect(s.requests.map((r) => r.text)).toEqual(["40", "32.0"]);
  });

  it("tabbing through it sends nothing, and Enter retries the typed value", () => {
    const s = lost();
    const before = s.saves();
    s.focus(QTY);
    expect(s.blur(QTY)).toBe("skip"); // rule 3 comes before rule 4
    expect(s.saves()).toBe(before);
    expect(s.requests).toHaveLength(1);
    expect(s.enter(QTY)).toBe("send"); // rule 5
    expect(s.requests.map((r) => r.text)).toEqual(["40", "40"]);
    expect(s.view(QTY)).toEqual(notSaved("40", NO_ANSWER, true));
    s.lands(2, [{ ...LEAD, qty: 40 }]);
    expect(s.view(QTY)).toEqual(savedView("40"));
    expect(s.notSaved()).toBe(false);
  });

  it("a payload that still shows the stored value settles nothing: the box stays Not saved and Restore still saves", () => {
    const s = lost();
    const before = s.saves();
    s.payload([{ ...LEAD, weight: 61 }]); // another section's save; this line's quantity is 32 in it
    expect(s.saves()).toBe(before);
    expect(s.view(QTY)).toEqual(notSaved("40", NO_ANSWER));
    expect(s.restore(QTY)).toBe("send");
    expect(s.requests.map((r) => r.text)).toEqual(["40", "32"]);
  });

  it("a payload that arrives while the restore-save is out is left alone, whichever value it shows", () => {
    for (const qty of [32, 40]) {
      const s = lost();
      expect(s.restore(QTY)).toBe("send");
      const out = s.saves();
      s.payload([{ ...LEAD, qty }]);
      expect(s.saves()).toBe(out);
      expect(s.view(QTY)).toEqual(notSaved("32", NO_ANSWER, true));
      expect(s.notSaved()).toBe(true);
      s.lands(2, [{ ...LEAD }]);
      expect(s.view(QTY)).toEqual(savedView("32"));
      expect(s.notSaved()).toBe(false);
    }
  });

  it("a restore-save the server refuses reads Not saved over the stored value, in the server's words, and the record stands", () => {
    const s = lost();
    expect(s.restore(QTY)).toBe("send");
    s.fails(2, BELOW_SHIPPED);
    expect(s.view(QTY)).toEqual(notSaved("32", BELOW_SHIPPED));
    // The refusal is the outcome the box reads. The record is about the first save, and stays.
    expect(s.saves().get(QTY)).toEqual({ draft: "32", pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED }, unanswered: true });
    expect(s.notSaved()).toBe(true);
  });

  it("an Enter retry the server refuses reads Not saved in the server's words, and the record stands", () => {
    const s = lost();
    expect(s.enter(QTY)).toBe("send");
    s.fails(2, BELOW_SHIPPED);
    expect(s.saves().get(QTY)).toEqual({ draft: "40", pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED }, unanswered: true });
    expect(s.notSaved()).toBe(true);
  });

  describe("when the restore-save is not answered either", () => {
    const BAD_GATEWAY = "Request failed (502)";
    function lostTwice() {
      const s = lost();
      expect(s.restore(QTY)).toBe("send");
      s.loses(2, BAD_GATEWAY);
      return s;
    }

    it("the box reads Not saved over the stored value, with the newer reason, and the record stands", () => {
      const s = lostTwice();
      expect(s.view(QTY)).toEqual(notSaved("32", BAD_GATEWAY));
      expect(s.saves().get(QTY)).toEqual({ draft: "32", pending: null, outcome: { kind: "failed", message: BAD_GATEWAY }, unanswered: true });
      expect(s.notSaved()).toBe(true);
    });

    it("tabbing through sends nothing; Enter, or Restore again, sends the stored value again", () => {
      const s = lostTwice();
      const before = s.saves();
      s.focus(QTY);
      expect(s.blur(QTY)).toBe("skip");
      expect(s.saves()).toBe(before);
      expect(s.enter(QTY)).toBe("send"); // rule 4: the stored value, on a box whose save was not answered
      expect(s.requests.map((r) => r.text)).toEqual(["40", "32", "32"]);
      const r = lostTwice();
      expect(r.restore(QTY)).toBe("send");
      expect(r.requests.map((q) => q.text)).toEqual(["40", "32", "32"]);
    });

    it("a later payload that shows the stored value settles nothing: Restore sends it again, and that save landing is what ends it", () => {
      const s = lostTwice();
      // The box holds 32 and so does this order. It may still be older than either lost write.
      const before = s.saves();
      s.payload([{ ...LEAD, weight: 61 }]);
      expect(s.saves()).toBe(before);
      expect(s.view(QTY)).toEqual(notSaved("32", BAD_GATEWAY));
      expect(s.notSaved()).toBe(true);
      expect(s.restore(QTY)).toBe("send");
      expect(s.requests.map((r) => r.text)).toEqual(["40", "32", "32"]);
      s.lands(3, [{ ...LEAD, weight: 61 }]);
      expect(s.view(QTY)).toEqual(savedView("32"));
      expect(s.notSaved()).toBe(false);
    });

    it("a later payload that shows the typed value leaves it Not saved, and Restore then saves that value", () => {
      const s = lostTwice();
      const before = s.saves();
      s.payload([{ ...LEAD, qty: 40 }]); // the first write did land, and the restore-save did not
      expect(s.saves()).toBe(before);
      // The box still holds 32, which the server does not: Not saved. The stored value is 40 now,
      // so that is what Restore names (FieldMark is handed it) and what Restore saves.
      expect(s.view(QTY)).toEqual(notSaved("32", BAD_GATEWAY));
      expect(s.notSaved()).toBe(true);
      expect(s.restore(QTY)).toBe("send");
      expect(s.requests.map((r) => r.text)).toEqual(["40", "32", "40"]);
      s.lands(3, [{ ...LEAD, qty: 40 }]);
      expect(s.view(QTY)).toEqual(savedView("40"));
      expect(s.notSaved()).toBe(false);
      // Enter sends the box's own 32 instead: it is no longer the stored value, so it is a new one.
      const e = lostTwice();
      e.payload([{ ...LEAD, qty: 40 }]);
      expect(e.enter(QTY)).toBe("send");
      expect(e.requests.map((r) => r.text)).toEqual(["40", "32", "32"]);
    });
  });

  // The record belongs to the box, not to its newest failure. Nothing the page learns afterwards
  // says what became of the lost write, short of a later save of that box landing: a refusal of a
  // later request does not, a refusal the page makes itself does not, a key typed does not, and an
  // order payload does not, whatever value it shows, because the page cannot tell whether that
  // order was read before or after the lost write. So none of them may turn Restore back into a
  // local clear, or let the stored value typed back settle with no request.
  describe("the record stays on the box", () => {
    const CONFLICT = "Another change to that order was saved at the same time — please try again";
    const NOT_FOUND = "Order not found";

    it("a 409 to the restore-save leaves it: Restore sends again, and when that save lands the box reads Saved and nothing is counted", () => {
      const s = lost();
      expect(s.restore(QTY)).toBe("send");
      s.fails(2, CONFLICT); // the server answered, and wrote nothing for THIS request
      expect(s.view(QTY)).toEqual(notSaved("32", CONFLICT));
      expect(s.notSaved()).toBe(true);
      // "Please try again": the operator does. It is a request, never a local clear.
      expect(s.restore(QTY)).toBe("send");
      expect(s.requests.map((r) => r.text)).toEqual(["40", "32", "32"]);
      expect(s.view(QTY)).toEqual(notSaved("32", CONFLICT, true));
      expect(s.notSaved()).toBe(true);
      s.lands(3, [{ ...LEAD }]);
      expect(s.view(QTY)).toEqual(savedView("32"));
      expect(s.saves().get(QTY)).toEqual({ draft: null, pending: null, outcome: { kind: "saved", text: "32" } });
      expect(s.notSaved()).toBe(false);
    });

    it("any refusal the server answers to the restore-save leaves it, however many times", () => {
      const s = lost();
      for (const [attempt, message] of [[2, BELOW_SHIPPED], [3, NOT_FOUND], [4, "Requires orders.edit"]] as const) {
        expect(s.restore(QTY)).toBe("send");
        s.fails(attempt, message);
        expect(s.view(QTY)).toEqual(notSaved("32", message));
        expect(s.notSaved()).toBe(true);
      }
      expect(s.requests.map((r) => r.text)).toEqual(["40", "32", "32", "32"]);
    });

    it.each([
      ["a typo", "4o"],
      ["an emptied box", ""],
    ])("%s refused by the page leaves it: Restore then saves the stored value", (_what, slip) => {
      const s = lost();
      s.focus(QTY); s.type(QTY, slip);
      expect(s.blur(QTY)).toBe("refused"); // no request: the page learned nothing about the server
      expect(s.view(QTY)).toEqual(notSaved(slip, NOT_WHOLE));
      expect(s.notSaved()).toBe(true);
      expect(s.restore(QTY)).toBe("send");
      expect(s.requests.map((r) => r.text)).toEqual(["40", "32"]);
      expect(s.view(QTY)).toEqual(notSaved("32", NOT_WHOLE, true));
      expect(s.notSaved()).toBe(true);
      s.lands(2, [{ ...LEAD }]);
      expect(s.view(QTY)).toEqual(savedView("32"));
      expect(s.notSaved()).toBe(false);
    });

    it("after a typo the page refused, the stored value typed back and left is sent, not settled", () => {
      const s = lost();
      s.focus(QTY); s.type(QTY, "4o");
      expect(s.enter(QTY)).toBe("refused");
      s.type(QTY, "32");
      expect(s.blur(QTY)).toBe("send"); // rule 4
      expect(s.requests.map((r) => r.text)).toEqual(["40", "32"]);
      expect(s.notSaved()).toBe(true);
    });

    it("an Enter retry the server refuses leaves it: Restore saves the stored value, and so does typing it back", () => {
      const s = lost();
      expect(s.enter(QTY)).toBe("send");
      s.fails(2, BELOW_SHIPPED); // a 400, to a request sent after the one that was lost
      expect(s.view(QTY)).toEqual(notSaved("40", BELOW_SHIPPED));
      expect(s.restore(QTY)).toBe("send");
      expect(s.requests.map((r) => r.text)).toEqual(["40", "40", "32"]);
      const t = lost();
      expect(t.enter(QTY)).toBe("send");
      t.fails(2, BELOW_SHIPPED);
      t.type(QTY, "32");
      expect(t.blur(QTY)).toBe("send");
      expect(t.requests.map((r) => r.text)).toEqual(["40", "40", "32"]);
    });

    it("a key typed while the restore-save is out leaves it: the box is counted at every step, mark or no mark", () => {
      const s = lost();
      s.focus(QTY); // focus is in the box, and the Restore control keeps it there
      expect(s.notSaved()).toBe(true);
      expect(s.restore(QTY)).toBe("send");
      expect(s.notSaved()).toBe(true);
      s.type(QTY, "3");
      // The mark is about text that is no longer in the box, so it goes while the save is out. The
      // box is counted all the same: the print gate does not open for the length of a request.
      expect(s.view(QTY)).toEqual({ text: "3", mark: null, message: null, saving: true });
      expect(s.notSaved()).toBe(true);
      s.fails(2, NOT_FOUND); // the order was voided since
      expect(s.view(QTY)).toEqual(notSaved("3", NOT_FOUND));
      expect(s.notSaved()).toBe(true);
      expect(s.restore(QTY)).toBe("send");
      expect(s.requests.map((r) => r.text)).toEqual(["40", "32", "32"]);
      expect(s.notSaved()).toBe(true);
    });

    it("after a Restore with focus in the box, a refused restore-save and then a blur send nothing more, and the mark and the server's words stay", () => {
      const s = lost();
      s.focus(QTY); // at focus the box held 40
      expect(s.restore(QTY)).toBe("send"); // the box now holds 32, and Restore records that as its text at focus
      s.fails(2, BELOW_SHIPPED);
      const refusedState = s.saves();
      expect(s.blur(QTY)).toBe("skip"); // rule 3: the box holds what Restore left in it
      expect(s.saves()).toBe(refusedState);
      expect(s.requests).toHaveLength(2);
      expect(s.view(QTY)).toEqual(notSaved("32", BELOW_SHIPPED));
      expect(s.notSaved()).toBe(true);
    });

    it("the same when the restore-save got no answer: the blur sends nothing more, and a value typed after Restore is sent", () => {
      const s = lost();
      s.focus(QTY);
      expect(s.restore(QTY)).toBe("send");
      s.loses(2);
      expect(s.blur(QTY)).toBe("skip");
      expect(s.requests).toHaveLength(2);
      expect(s.view(QTY)).toEqual(notSaved("32", NO_ANSWER));
      // The typed value again, after Restore: it is not what the box held when Restore left it.
      const t = lost();
      t.focus(QTY);
      expect(t.restore(QTY)).toBe("send");
      t.loses(2);
      t.type(QTY, "40");
      expect(t.blur(QTY)).toBe("send");
      expect(t.requests.map((r) => r.text)).toEqual(["40", "32", "40"]);
    });

    it("Restore on one box does not move the text at focus of the other", () => {
      const s = section();
      s.focus(WEIGHT); s.type(WEIGHT, "5"); s.blur(WEIGHT);
      s.fails(1, "Lead (ACME · P-100): cannot reduce net weight below 10 lb already shipped");
      s.focus(QTY); s.type(QTY, "40"); s.blur(QTY);
      s.loses(2);
      s.focus(WEIGHT); // the weight box holds its refused 5 at focus
      // The quantity's Restore, clicked with focus in the weight box. Written over the text at
      // focus, the quantity's stored 32 would make the weight's 5 read as changed since focus.
      expect(s.restore(QTY)).toBe("send");
      expect(s.blur(WEIGHT)).toBe("skip"); // still the value it held at focus: nothing is sent for it
      expect(s.requests.map((r) => r.text)).toEqual(["5", "40", "32"]);
    });

    it("goes when a save of the box lands: a refusal after that is an answered one again", () => {
      // The Enter retry lands. The server holds what was sent, and the page knows it.
      const s = lost();
      expect(s.enter(QTY)).toBe("send");
      // Answered, and the order it carried not yet applied: the record is gone at the landing
      // itself, so the section stops counting the box in the same step that marks it Saved.
      s.answers(2);
      expect(s.saves().get(QTY)).toEqual({ draft: "40", pending: null, outcome: { kind: "saved", text: "40" } });
      expect(s.view(QTY)).toEqual(savedView("40"));
      expect(s.notSaved()).toBe(false);
      s.payload([{ ...LEAD, qty: 40 }]);
      expect(s.saves().get(QTY)).toEqual({ draft: null, pending: null, outcome: { kind: "saved", text: "40" } });
      expect(s.notSaved()).toBe(false);
      s.focus(QTY); s.type(QTY, "20");
      expect(s.blur(QTY)).toBe("send");
      s.fails(3, BELOW_SHIPPED);
      expect(s.restore(QTY)).toBe("clear");
      expect(s.view(QTY)).toEqual(quiet("40"));
      expect(s.notSaved()).toBe(false);
      expect(s.requests).toHaveLength(3);
    });

    it("goes when the save lands although the text has moved on since it was sent", () => {
      const s = lost();
      expect(s.enter(QTY)).toBe("send");
      s.type(QTY, "45"); // typed while the retry is out
      expect(s.notSaved()).toBe(true);
      s.lands(2, [{ ...LEAD, qty: 40 }]);
      // The server holds the 40 that was sent. 45 is text being typed, as in any box.
      expect(s.saves().get(QTY)).toEqual({ draft: "45", pending: null, outcome: null });
      expect(s.view(QTY)).toEqual(quiet("45"));
      expect(s.notSaved()).toBe(false);
      // And a refusal the page made while the save was out stays, as an answered one.
      const t = lost();
      expect(t.enter(QTY)).toBe("send");
      t.type(QTY, "4o");
      expect(t.blur(QTY)).toBe("refused");
      t.lands(2, [{ ...LEAD, qty: 40 }]);
      expect(t.saves().get(QTY)).toEqual({ draft: "4o", pending: null, outcome: { kind: "failed", message: NOT_WHOLE } });
      expect(t.restore(QTY)).toBe("clear");
      expect(t.view(QTY)).toEqual(quiet("40"));
    });

    it("an older attempt landing does not take it: only the save the box is waiting on does", () => {
      const s = section();
      s.focus(QTY); s.type(QTY, "40"); s.blur(QTY); // attempt 1, slow
      s.focus(QTY); s.type(QTY, "45"); s.blur(QTY); // attempt 2
      s.loses(2);
      const before = s.saves();
      s.answers(1); // the page dropped its payload: a newer one had been applied
      expect(s.saves()).toBe(before);
      expect(s.restore(QTY)).toBe("send");
    });

    it("a payload alone never takes it: not one that shows another value, and not one that shows the box's own text", () => {
      // The box shows the stored value, after a restore-save the server refused.
      const s = lost();
      expect(s.restore(QTY)).toBe("send");
      s.fails(2, CONFLICT);
      // A payload that shows another value says nothing about the lost write: it may have been
      // read before that write was committed. The record stands.
      const before = s.saves();
      s.payload([{ ...LEAD, qty: 35 }]);
      expect(s.saves()).toBe(before);
      expect(s.notSaved()).toBe(true);
      expect(s.restore(QTY)).toBe("send");
      expect(s.requests.map((r) => r.text)).toEqual(["40", "32", "35"]);
      // A payload that shows the box's own text says no more than that one does: it too may have
      // been read before the lost write. The entry stays, record and all, and Restore still sends.
      const t = lost();
      expect(t.restore(QTY)).toBe("send");
      t.fails(2, CONFLICT);
      const refusedState = t.saves();
      t.payload([{ ...LEAD, weight: 61 }]); // the quantity in it is the 32 the box shows
      expect(t.saves()).toBe(refusedState);
      expect(t.view(QTY)).toEqual(notSaved("32", CONFLICT));
      expect(t.notSaved()).toBe(true);
      expect(t.restore(QTY)).toBe("send");
      expect(t.requests.map((r) => r.text)).toEqual(["40", "32", "32"]);
      // That save landing is what takes the record: a refusal after it is an answered one again.
      t.lands(3, [{ ...LEAD, weight: 61 }]);
      expect(t.view(QTY)).toEqual(savedView("32"));
      expect(t.notSaved()).toBe(false);
      t.focus(QTY); t.type(QTY, "20");
      expect(t.blur(QTY)).toBe("send");
      t.fails(4, BELOW_SHIPPED);
      expect(t.restore(QTY)).toBe("clear");
      expect(t.requests).toHaveLength(4);
    });

    it("an older attempt's order, applied after a newer attempt was lost, leaves it: the box reads Not saved over the value it shows, and leaving the box sends that value", () => {
      const s = section();
      s.focus(QTY); s.type(QTY, "40");
      expect(s.enter(QTY)).toBe("send"); // attempt 1: 40
      s.type(QTY, "32");
      expect(s.enter(QTY)).toBe("send"); // attempt 2: back to 32, sent because 40 is out (rule 1)
      s.loses(2); // the server may hold 32, written after the 40
      expect(s.notSaved()).toBe(true);
      s.type(QTY, "40");
      // Attempt 1's answer arrives now. The page applies its order, the order as attempt 1 left it:
      // nothing newer was applied, because a request that fails never advances the page's gate.
      // That order shows the very text in the box, and it is older than the lost write.
      s.answers(1, [{ ...LEAD, qty: 40 }]);
      s.reconcile();
      expect(s.saves().get(QTY)).toEqual({ draft: "40", pending: null, outcome: { kind: "failed", message: NO_ANSWER }, unanswered: true });
      expect(s.view(QTY)).toEqual(notSaved("40", NO_ANSWER));
      expect(s.notSaved()).toBe(true);
      // The box holds what the page now shows as stored. With the record standing that is sent,
      // not settled (rule 4), on Enter and on the blur alike.
      expect(saveIntent({ save: s.saves().get(QTY), server: "40", text: "40", atFocus: null })).toBe("send");
      expect(s.blur(QTY)).toBe("send"); // at focus the box held the 32 Enter left
      expect(s.requests.map((r) => r.text)).toEqual(["40", "32", "40"]);
      s.lands(3, [{ ...LEAD, qty: 40 }]);
      expect(s.view(QTY)).toEqual(savedView("40"));
      expect(s.notSaved()).toBe(false);
    });

    it("a payload that arrives while a key typed during the retry is in the box is left alone", () => {
      const s = lost();
      expect(s.enter(QTY)).toBe("send");
      s.type(QTY, "4");
      const out = s.saves();
      s.payload([{ ...LEAD, weight: 61 }]);
      expect(s.saves()).toBe(out);
      expect(s.notSaved()).toBe(true);
    });
  });

  // Two saves of one box can be out at once: the page's gate lets requests overlap, and the box
  // waits on the newer. The older is still a write the server may have committed, so when it ends
  // with no answer the box records that, whatever the box holds by then: the newer save still out,
  // the newer save's refusal, text typed since, a Saved mark, or nothing at all. An answer to the
  // older one, landing or refusal, is still ignored.
  describe("an unanswered save that a newer save of the box had replaced", () => {
    /** 40 is saved with Enter, and 45 typed and left while it is out: attempt 1 is the older save,
     *  attempt 2 the one the box waits on. */
    function twoOut() {
      const s = section();
      s.focus(QTY); s.type(QTY, "40");
      expect(s.enter(QTY)).toBe("send"); // attempt 1
      s.type(QTY, "45");
      expect(s.blur(QTY)).toBe("send"); // attempt 2
      expect(s.requests.map((r) => r.text)).toEqual(["40", "45"]);
      return s;
    }

    it("while the newer save is out: the record is set and nothing else changes, and the section counts the box", () => {
      const s = twoOut();
      expect(s.notSaved()).toBe(false);
      s.loses(1); // the server may have written 40
      expect(s.saves().get(QTY)).toEqual({ draft: "45", pending: { attempt: 2, text: "45" }, outcome: null, unanswered: true });
      // The box still reads as a save in flight. It is counted all the same: the print waits.
      expect(s.view(QTY)).toEqual({ text: "45", mark: null, message: null, saving: true });
      expect(s.notSaved()).toBe(true);
    });

    it("the newer save is then refused: the record stands, and Restore saves the stored value", () => {
      const s = twoOut();
      s.loses(1);
      s.fails(2, BELOW_SHIPPED); // answered: nothing was written for 45
      expect(s.saves().get(QTY)).toEqual({ draft: "45", pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED }, unanswered: true });
      expect(s.view(QTY)).toEqual(notSaved("45", BELOW_SHIPPED));
      expect(restoreIntent(s.saves().get(QTY))).toBe("send");
      expect(s.restore(QTY)).toBe("send");
      expect(s.requests.map((r) => r.text)).toEqual(["40", "45", "32"]);
      expect(s.view(QTY)).toEqual(notSaved("32", BELOW_SHIPPED, true));
      expect(s.notSaved()).toBe(true);
      s.lands(3, [{ ...LEAD }]);
      expect(s.view(QTY)).toEqual(savedView("32"));
      expect(s.notSaved()).toBe(false);
    });

    it("the newer save then lands: the record goes, and the box reads Saved", () => {
      const s = twoOut();
      s.loses(1);
      // Attempt 2 was sent after the lost one and the server answered it: it holds 45.
      s.lands(2, [{ ...LEAD, qty: 45 }]);
      expect(s.saves().get(QTY)).toEqual({ draft: null, pending: null, outcome: { kind: "saved", text: "45" } });
      expect(s.view(QTY)).toEqual(savedView("45"));
      expect(s.notSaved()).toBe(false);
      expect(restoreIntent(s.saves().get(QTY))).toBe("clear");
    });

    it("the newer save was refused first: the box keeps the refusal's words, and Restore now saves", () => {
      const s = twoOut();
      s.fails(2, BELOW_SHIPPED);
      expect(restoreIntent(s.saves().get(QTY))).toBe("clear");
      s.loses(1);
      expect(s.saves().get(QTY)).toEqual({ draft: "45", pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED }, unanswered: true });
      expect(s.view(QTY)).toEqual(notSaved("45", BELOW_SHIPPED));
      expect(s.restore(QTY)).toBe("send");
      expect(s.requests.map((r) => r.text)).toEqual(["40", "45", "32"]);
      // The stored value typed back and left is sent too (rule 4), where it settled before.
      const t = twoOut();
      t.fails(2, BELOW_SHIPPED);
      t.loses(1);
      t.focus(QTY); t.type(QTY, "32");
      expect(t.blur(QTY)).toBe("send");
      expect(t.requests.map((r) => r.text)).toEqual(["40", "45", "32"]);
    });

    it("text typed after the newer save landed: the box reads Not saved on that text, in the lost save's words", () => {
      const s = twoOut();
      s.focus(QTY); s.type(QTY, "450"); // typing on while attempt 2 is out
      s.lands(2, [{ ...LEAD, qty: 45 }]);
      expect(s.saves().get(QTY)).toEqual({ draft: "450", pending: null, outcome: null });
      s.loses(1);
      expect(s.saves().get(QTY)).toEqual({ draft: "450", pending: null, outcome: { kind: "failed", message: NO_ANSWER }, unanswered: true });
      expect(s.view(QTY)).toEqual(notSaved("450", NO_ANSWER));
      expect(s.notSaved()).toBe(true);
    });

    it("the newer save had already landed: the Saved mark becomes Not saved over the stored value, until Enter or Restore lands", () => {
      // The server holds 45 if it took the two requests in the order they were sent. The box does
      // not keep a record of landings to know it by, so it reads Not saved all the same: the cost
      // is a mark that waits for Enter or Restore, never a clean box over a value in doubt.
      const landedThenLost = () => {
        const s = twoOut();
        s.lands(2, [{ ...LEAD, qty: 45 }]);
        expect(s.view(QTY)).toEqual(savedView("45"));
        s.loses(1);
        expect(s.saves().get(QTY)).toEqual({ draft: null, pending: null, outcome: { kind: "failed", message: NO_ANSWER }, unanswered: true });
        expect(s.view(QTY)).toEqual(notSaved("45", NO_ANSWER));
        expect(s.notSaved()).toBe(true);
        return s;
      };
      // Tabbing through the box sends nothing: nobody has typed in it.
      const s = landedThenLost();
      const before = s.saves();
      s.focus(QTY);
      expect(s.blur(QTY)).toBe("skip");
      expect(s.saves()).toBe(before);
      // Enter sends the value the box shows, the stored one, and its landing ends Not saved.
      expect(s.enter(QTY)).toBe("send");
      expect(s.requests.map((r) => r.text)).toEqual(["40", "45", "45"]);
      expect(s.view(QTY)).toEqual(notSaved("45", NO_ANSWER, true));
      s.lands(3, [{ ...LEAD, qty: 45 }]);
      expect(s.view(QTY)).toEqual(savedView("45"));
      expect(s.notSaved()).toBe(false);
      // So does Restore.
      const r = landedThenLost();
      expect(r.restore(QTY)).toBe("send");
      expect(r.requests.map((q) => q.text)).toEqual(["40", "45", "45"]);
      r.lands(3, [{ ...LEAD, qty: 45 }]);
      expect(r.view(QTY)).toEqual(savedView("45"));
      expect(r.notSaved()).toBe(false);
    });

    it("the box had been restored and holds no entry: one is made, Not saved over the stored value, and Restore saves it", () => {
      const s = twoOut();
      s.fails(2, BELOW_SHIPPED);
      expect(s.restore(QTY)).toBe("clear"); // nothing had gone unanswered yet
      expect(s.saves().has(QTY)).toBe(false);
      s.loses(1);
      expect(s.saves().get(QTY)).toEqual({ draft: null, pending: null, outcome: { kind: "failed", message: NO_ANSWER }, unanswered: true });
      expect(s.view(QTY)).toEqual(notSaved("32", NO_ANSWER));
      expect(s.notSaved()).toBe(true);
      expect(s.restore(QTY)).toBe("send");
      expect(s.requests.map((r) => r.text)).toEqual(["40", "45", "32"]);
      expect(s.view(QTY)).toEqual(notSaved("32", NO_ANSWER, true));
      s.lands(3, [{ ...LEAD }]);
      expect(s.view(QTY)).toEqual(savedView("32"));
      expect(s.notSaved()).toBe(false);
    });

    it("a refusal the server answered to the older save is still ignored, whatever the box holds by then", () => {
      // Nothing was written for it, and the value it carried is no longer the box's.
      const out = twoOut();
      const whileOut = out.saves();
      out.fails(1, BELOW_SHIPPED);
      expect(out.saves()).toBe(whileOut);
      const refused2 = twoOut();
      refused2.fails(2, "Order not found");
      const afterRefusal = refused2.saves();
      refused2.fails(1, BELOW_SHIPPED);
      expect(refused2.saves()).toBe(afterRefusal);
      expect(restoreIntent(refused2.saves().get(QTY))).toBe("clear");
      const restored = twoOut();
      restored.fails(2, "Order not found");
      expect(restored.restore(QTY)).toBe("clear");
      const afterRestore = restored.saves();
      restored.fails(1, BELOW_SHIPPED);
      expect(restored.saves()).toBe(afterRestore);
      expect(restored.saves().has(QTY)).toBe(false);
    });
  });

  // A box that never had a save go unanswered is as it was before any of this: a refusal is an
  // answer, the stored value on the page is what the server holds, and nothing needs to be sent.
  describe("a box no save of which went unanswered", () => {
    /** A refusal the server answered, then a typo the page refused, then another server refusal. */
    function refusedTypoRefused() {
      const s = section();
      s.focus(QTY); s.type(QTY, "20");
      expect(s.blur(QTY)).toBe("send");
      s.fails(1, BELOW_SHIPPED);
      s.focus(QTY); s.type(QTY, "2o");
      expect(s.blur(QTY)).toBe("refused");
      s.focus(QTY); s.type(QTY, "21");
      expect(s.blur(QTY)).toBe("send");
      s.fails(2, BELOW_SHIPPED);
      expect(s.saves().get(QTY)).toEqual({ draft: "21", pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED } });
      return s;
    }

    it("after a refusal the server answered, a typo and another refusal, Restore clears the box and sends nothing", () => {
      const s = refusedTypoRefused();
      expect(s.restore(QTY)).toBe("clear");
      expect(s.saves().has(QTY)).toBe(false);
      expect(s.view(QTY)).toEqual(quiet("32"));
      expect(s.notSaved()).toBe(false);
      expect(s.requests).toHaveLength(2);
    });

    it("from the same state, the stored value typed back and left settles with no request", () => {
      const s = refusedTypoRefused();
      s.focus(QTY); s.type(QTY, "32");
      expect(s.blur(QTY)).toBe("settle");
      expect(s.saves().has(QTY)).toBe(false);
      expect(s.notSaved()).toBe(false);
      expect(s.requests).toHaveLength(2);
    });

    it("a key typed while a retry of a refused value is out: the box is not counted for that moment, as before", () => {
      const s = section();
      s.focus(QTY); s.type(QTY, "20"); s.enter(QTY);
      s.fails(1, BELOW_SHIPPED);
      expect(s.enter(QTY)).toBe("send");
      s.type(QTY, "2");
      expect(s.view(QTY)).toEqual({ text: "2", mark: null, message: null, saving: true });
      expect(s.notSaved()).toBe(false);
    });
  });
});

// A sequence that ends with a box reading Saved over a value the server may not hold. It is known
// and left as it is (HANDOFF §4, under R9): it turns on the order in which answers reach the
// page, and closing it means changing the page's mutation gate. Pinned here so that a change to
// it is a decision. It is not what the box should do.
describe("scenarios: a known residual, pinned as it is", () => {
  it("a box reads Saved over the value it sent while the page already shows a newer value from another session, until the next payload", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.blur(QTY);
    s.payload([{ ...LEAD, qty: 50 }]); // another session's write, read by the page while the save is out
    s.answers(1); // this save's own order is older than the one applied, and the page drops it
    expect(s.view(QTY)).toEqual(savedView("40"));
    expect(s.notSaved()).toBe(false);
    s.payload([{ ...LEAD, qty: 50, weight: 61 }]);
    expect(s.saves().has(QTY)).toBe(false);
    expect(s.view(QTY)).toEqual(quiet("50"));
  });
});

describe("scenarios: a response the page dropped", () => {
  it("the box keeps the sent text with Saved while the server value is still the old one, until a payload arrives", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.blur(QTY);
    s.answers(1); // no fresh order was applied, so `lines` is the same array and no effect runs
    expect(s.saves().get(QTY)).toEqual({ draft: "40", pending: null, outcome: { kind: "saved", text: "40" } });
    expect(s.view(QTY)).toEqual(savedView("40"));
    s.focus(QTY);
    expect(s.blur(QTY)).toBe("skip");
    s.payload([{ ...LEAD, qty: 40 }]);
    expect(s.saves().get(QTY)).toEqual({ draft: null, pending: null, outcome: { kind: "saved", text: "40" } });
    expect(s.view(QTY)).toEqual(savedView("40"));
  });

  it("a payload that contradicts the saved value drops the mark and shows what the server holds", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.blur(QTY);
    s.answers(1);
    s.payload([{ ...LEAD, qty: 35 }]);
    expect(s.saves().has(QTY)).toBe(false);
    expect(s.view(QTY)).toEqual(quiet("35"));
  });
});

describe("scenarios: a read of the order that overlapped the save (#550)", () => {
  // The page reads the order once more after a hub write that was out as a read was sent (owner
  // ruling 2026-10-18, "read now, re-read after"; the plan's amendment 1), and these are the two
  // orders in which the stale read and the save's answer can land, then that read. Each step is
  // already pinned by a single-step case below, of `dispatched`, `landed` or `reconciled`, so the two
  // sequences only document where the box ends.

  it("ordering (a): the stale read lands first and the answer is dropped; the read after it leaves the box Saved, with no draft", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.blur(QTY);
    s.payload([LEAD]); // served before the save committed: the save is still out, so it is left alone
    expect(s.view(QTY)).toEqual({ text: "40", mark: null, message: null, saving: true });
    s.answers(1); // older-ticketed than the read, and dropped
    expect(s.view(QTY)).toEqual(savedView("40")); // over figures from before the save, until:
    s.payload([{ ...LEAD, qty: 40 }]);
    expect(s.saves().get(QTY)).toEqual({ draft: null, pending: null, outcome: { kind: "saved", text: "40" } });
    expect(s.view(QTY)).toEqual(savedView("40"));
    expect(s.notSaved()).toBe(false);
  });

  it("ordering (b): the answer lands first and the stale read reverts it; the read after it shows the server's value with no mark (accepted)", () => {
    const s = section();
    s.focus(QTY); s.type(QTY, "40"); s.blur(QTY);
    s.lands(1, [{ ...LEAD, qty: 40 }]);
    expect(s.view(QTY)).toEqual(savedView("40"));
    s.payload([LEAD]); // served before the save committed, applied after its answer
    expect(s.saves().has(QTY)).toBe(false);
    expect(s.view(QTY)).toEqual(quiet("32"));
    s.payload([{ ...LEAD, qty: 40 }]);
    expect(s.saves().has(QTY)).toBe(false);
    expect(s.view(QTY)).toEqual(quiet("40"));
    expect(s.notSaved()).toBe(false);
  });
});

describe("scenarios: an accepted offer", () => {
  it("is sent although the weight box holds no draft", () => {
    const s = section();
    expect(s.use(WEIGHT, "48")).toBe("send");
    expect(s.requests).toEqual([{ attempt: 1, key: WEIGHT, text: "48" }]);
    expect(s.view(WEIGHT)).toEqual({ text: "48", mark: null, message: null, saving: true });
    expect(s.use(WEIGHT, "48")).toBe("skip"); // a second click while it is out
    s.lands(1, [{ ...LEAD, weight: 48 }]);
    expect(s.view(WEIGHT)).toEqual(savedView("48"));
  });

  it("is sent over a Saved weight, and over a different weight in flight", () => {
    const s = section();
    s.focus(WEIGHT); s.type(WEIGHT, "55"); s.blur(WEIGHT);
    s.lands(1, [{ ...LEAD, weight: 55 }]);
    expect(s.use(WEIGHT, "48")).toBe("send");
    expect(s.view(WEIGHT)).toEqual({ text: "48", mark: null, message: null, saving: true });
    expect(s.use(WEIGHT, "47")).toBe("send");
    expect(s.requests.map((r) => r.text)).toEqual(["55", "48", "47"]);
  });

  it("that fails reads Not saved, and the next click sends it again", () => {
    const s = section();
    expect(s.use(WEIGHT, "48")).toBe("send");
    s.loses(1);
    expect(s.view(WEIGHT)).toEqual({ text: "48", mark: "not-saved", message: NO_ANSWER, saving: false });
    expect(s.use(WEIGHT, "48")).toBe("send");
    s.lands(2, [{ ...LEAD, weight: 48 }]);
    expect(s.view(WEIGHT)).toEqual(savedView("48"));
    expect(s.notSaved()).toBe(false);
  });

  it("is not sent when the box already holds that figure", () => {
    const s = section();
    expect(s.use(WEIGHT, "60")).toBe("skip");
    expect(s.use(WEIGHT, "60.00")).toBe("skip");
    expect(s.requests).toHaveLength(0);
  });

  it("accepted with focus in the weight box and not saved: the blur that follows sends nothing more (rule 3)", () => {
    const BELOW_WEIGHT = "Lead (ACME · P-100): cannot reduce net weight below 50 lb already shipped";
    for (const end of ["refused", "lost"] as const) {
      const s = section();
      s.focus(WEIGHT); // at focus the box holds the stored 60, and Use leaves focus in it
      expect(s.use(WEIGHT, "48")).toBe("send");
      if (end === "refused") s.fails(1, BELOW_WEIGHT);
      else s.loses(1);
      const notSavedState = s.saves();
      // The box holds the figure, which is what it is taken to have held at focus.
      expect(s.blur(WEIGHT)).toBe("skip");
      expect(s.saves()).toBe(notSavedState);
      expect(s.requests).toHaveLength(1);
      expect(s.view(WEIGHT).mark).toBe("not-saved");
    }
    // With focus in the quantity box the weight's figure moves nothing. That box holds a Not saved
    // 45 it also held when focus arrived, so leaving it sends nothing. Had the figure been taken
    // as ITS text at focus, the 45 would read as changed since focus and go out again.
    const q = section();
    q.type(QTY, "45");
    expect(q.blur(QTY)).toBe("send");
    q.fails(1, "Lead (ACME · P-100): quantity refused");
    q.focus(QTY);
    expect(q.use(WEIGHT, "48")).toBe("send");
    q.fails(2, BELOW_WEIGHT);
    expect(q.blur(QTY)).toBe("skip");
    expect(q.requests.map((r) => r.text)).toEqual(["45", "48"]);
  });
});

// ---- the functions one at a time ----

const save = (over: Partial<FieldSave> = {}): FieldSave => ({ draft: null, pending: null, outcome: null, ...over });
const SAVED = (text: string) => ({ kind: "saved", text }) as const;
const FAILED = (message: string) => ({ kind: "failed", message }) as const;
const OUT = (attempt: number, text: string) => ({ attempt, text });
/** An entry that carries the box's record that a save of it went unanswered. */
const recorded = (over: Partial<FieldSave> = {}): FieldSave => ({ ...save(over), unanswered: true });
/** The same entry with the record spelled out as absent. It must read as no record at all. */
const explicitlyNone = (over: Partial<FieldSave> = {}): FieldSave => ({ ...save(over), unanswered: false });
const of = (entries: Record<string, FieldSave>): FieldSaves => new Map(Object.entries(entries));

describe("fieldKey and serverValues", () => {
  it("keys a field by line id and field", () => {
    expect(fieldKey("L1", "qty")).toBe("L1:qty");
    expect(fieldKey("L1", "weight")).toBe("L1:weight");
  });

  it("lists every line's two values as the text a box shows", () => {
    expect([...serverValues([LEAD, { id: "L2", qty: 5, weight: 48.5 }])]).toEqual([
      ["L1:qty", "32"], ["L1:weight", "60"], ["L2:qty", "5"], ["L2:weight", "48.5"],
    ]);
    expect(serverValues([]).size).toBe(0);
  });
});

describe("sameValue", () => {
  it.each([
    ["40", "40"], [" 40 ", "40"], ["48.50", "48.5"], ["32.0", "32"], ["040", "40"], ["-0", "0"],
    [".5", "0.5"], ["abc", "abc"], ["", ""],
  ])("%j is %j", (text, server) => {
    expect(sameValue(text, server)).toBe(true);
  });

  it.each([
    ["40", "41"], ["48.5", "48.51"], ["4.", "4"], ["", "0"], [" ", "0"], ["+4", "4"],
    ["4o", "40"], ["1e2", "100"], ["0x10", "16"],
  ])("%j is not %j", (text, server) => {
    expect(sameValue(text, server)).toBe(false);
  });

  it("two numbers too long to read are not equal for being unreadable", () => {
    expect(sameValue("9".repeat(400), "8".repeat(400))).toBe(false);
  });
});

describe("decimal entry (#517, O4)", () => {
  it("sameValue reads a leading point, and leaves a trailing point unfinished", () => {
    expect(sameValue(".5", "0.5")).toBe(true);
    expect(sameValue("-.5", "-0.5")).toBe(true);
    expect(sameValue("4.", "4")).toBe(false);
  });

  it("sameSentValue reads a trailing point as the figure it was sent as", () => {
    expect(sameSentValue("36.", "36")).toBe(true);
    expect(sameSentValue(".5", "0.5")).toBe(true);
    expect(sameSentValue("9".repeat(400), "9".repeat(400))).toBe(true); // same text
    expect(sameSentValue("9".repeat(400), "8".repeat(400))).toBe(false);
  });

  it.each([[".5", "0.5"], ["36.", "36"]])("a box saved as %j reads %j and Saved once the payload arrives", (typed, stored) => {
    const key = fieldKey("L1", "weight");
    let saves = dispatched(NO_FIELD_SAVES, key, typed, 1);
    saves = landed(saves, key, 1);
    saves = reconciled(saves, new Map([[key, stored]]));
    expect(fieldView(saves.get(key), stored)).toEqual({ text: stored, mark: "saved", message: null, saving: false });
  });

  it.each([[".5", "0.5"], ["36.", "36"]])("a box saved as %j keeps its Saved mark through the next payload of %j", (typed, stored) => {
    const key = fieldKey("L1", "weight");
    let saves = dispatched(NO_FIELD_SAVES, key, typed, 1);
    saves = landed(saves, key, 1);
    saves = reconciled(saves, new Map([[key, stored]])); // the draft goes; the outcome keeps the sent text
    const after = reconciled(saves, new Map([[key, stored]]));
    expect(after).toBe(saves);
    expect(fieldView(after.get(key), stored)).toEqual({ text: stored, mark: "saved", message: null, saving: false });
  });

  it("text typed as far as its point is never settled or replaced while being typed", () => {
    const key = fieldKey("L1", "weight");
    expect(saveIntent({ save: undefined, server: "4", text: "4.", atFocus: "4" })).toBe("send");
    const typing = new Map([[key, { draft: "4.", pending: null, outcome: null }]]);
    expect(reconciled(typing, new Map([[key, "4"]]))).toBe(typing);
  });
});

describe("checkLineField", () => {
  it.each(["0", "-1", "2.5", "4o", "abc", "", "  "])("refuses the quantity %j in the existing words", (text) => {
    expect(checkLineField("qty", text, "Lead")).toBe("Lead: quantity must be a whole number of at least 1.");
  });

  it.each(["1", "40", " 40 ", "40.0"])("accepts the quantity %j", (text) => {
    expect(checkLineField("qty", text, "Lead")).toBeNull();
  });

  it.each(["0", "0.00", "-1", "", "  "])("refuses the weight %j as not over zero, naming the box by its label", (text) => {
    expect(checkLineField("weight", text, "Lead")).toBe("Lead, Net weight (lb): must be greater than zero.");
  });

  it.each(["4o", "abc"])("refuses the weight %j as no number", (text) => {
    expect(checkLineField("weight", text, "Lead"))
      .toBe("Lead, Net weight (lb): enter a number without $ or commas, such as 0.36.");
  });

  it("refuses a weight with more than 2 digits after the point", () => {
    expect(checkLineField("weight", "1.005", "Lead")).toBe("Lead, Net weight (lb): use at most 2 digits after the point.");
  });

  it.each(["0.01", "1", "48.5", " 60 ", "2.5", ".5", "36."])("accepts the weight %j", (text) => {
    expect(checkLineField("weight", text, "Lead")).toBeNull();
  });

  it("names the line it was given", () => {
    expect(checkLineField("qty", "0", "Line 3")).toBe("Line 3: quantity must be a whole number of at least 1.");
    expect(checkLineField("weight", "0", "Line 2")).toBe("Line 2, Net weight (lb): must be greater than zero.");
  });
});

describe("saveIntent", () => {
  it("asks about a save in flight first: nothing else is consulted while one is out", () => {
    // No draft, the stored text, unchanged since focus: rules 2, 3 and 4 would each have answered.
    const inFlight = save({ pending: OUT(1, "40") });
    expect(saveIntent({ save: inFlight, server: "32", text: "32", atFocus: "32" })).toBe("send");
    expect(saveIntent({ save: inFlight, server: "32", text: "40", atFocus: "32" })).toBe("skip");
  });

  it("an unchanged blur skips a box that reads Not saved or Saved, and Enter does not", () => {
    const notSaved = save({ draft: "20", outcome: FAILED("no") });
    const savedWaiting = save({ draft: "40", outcome: SAVED("40") });
    expect(saveIntent({ save: notSaved, server: "32", text: "20", atFocus: "20" })).toBe("skip");
    expect(saveIntent({ save: savedWaiting, server: "32", text: "40", atFocus: "40" })).toBe("skip");
    expect(saveIntent({ save: notSaved, server: "32", text: "20", atFocus: null })).toBe("send");
    expect(saveIntent({ save: savedWaiting, server: "32", text: "40", atFocus: null })).toBe("send");
  });

  it("an unchanged blur is judged by value, not spelling: Enter's raw text against the text the save left in the box", () => {
    // Enter records the box's raw text as the text held at focus; the save then shows the spelling
    // its request carried ("020" is sent, and shown, as 20). The blur that follows holds the same value.
    const notSaved = save({ draft: "20", outcome: FAILED("no") });
    const savedWaiting = save({ draft: "20", outcome: SAVED("20") });
    for (const atFocus of ["020", " 20", "20 ", "20.0", "20.00"]) {
      expect(saveIntent({ save: notSaved, server: "32", text: "20", atFocus })).toBe("skip");
      expect(saveIntent({ save: savedWaiting, server: "32", text: "20", atFocus })).toBe("skip");
    }
    // A weight is shown trimmed, however it was typed.
    const weightNotSaved = save({ draft: "48.5", outcome: FAILED("no") });
    const weightSaved = save({ draft: "48.5", outcome: SAVED("48.5") });
    for (const atFocus of ["48.5 ", "48.50", " 48.5"]) {
      expect(saveIntent({ save: weightNotSaved, server: "60", text: "48.5", atFocus })).toBe("skip");
      expect(saveIntent({ save: weightSaved, server: "60", text: "48.5", atFocus })).toBe("skip");
    }
  });

  it("a blur that leaves a different value than the box held at focus still sends, spelled alike or not", () => {
    const notSaved = save({ draft: "20", outcome: FAILED("no") });
    const savedWaiting = save({ draft: "20", outcome: SAVED("20") });
    for (const atFocus of ["21", "200", "02", "", "2o"]) {
      expect(saveIntent({ save: notSaved, server: "32", text: "20", atFocus })).toBe("send");
      expect(saveIntent({ save: savedWaiting, server: "32", text: "20", atFocus })).toBe("send");
    }
    // Enter carries no at-focus text and always reaches the value rules.
    expect(saveIntent({ save: notSaved, server: "32", text: "20", atFocus: null })).toBe("send");
    // The same value in another spelling is still not a reason to skip a draft that carries no mark.
    expect(saveIntent({ save: save({ draft: "20" }), server: "32", text: "20", atFocus: "020" })).toBe("send");
  });

  it("a draft with no mark is never skipped: the stored value settles, anything else sends", () => {
    expect(saveIntent({ save: save({ draft: "32" }), server: "32", text: "32", atFocus: "32" })).toBe("settle");
    expect(saveIntent({ save: save({ draft: "40" }), server: "32", text: "40", atFocus: "40" })).toBe("send");
    expect(saveIntent({ save: save({ draft: "40" }), server: "32", text: "40", atFocus: "32" })).toBe("send");
  });

  it("the stored value over a Not saved box settles where no save of the box went unanswered, and is sent where one did", () => {
    const noRecord = save({ draft: "32", outcome: FAILED("no") });
    const noRecordInSoManyWords = explicitlyNone({ draft: "32", outcome: FAILED("no") });
    const record = recorded({ draft: "32", outcome: FAILED("no") });
    // On Enter (no at-focus text) and on a blur that changed the box.
    for (const atFocus of [null, "40"]) {
      expect(saveIntent({ save: noRecord, server: "32", text: "32", atFocus })).toBe("settle");
      expect(saveIntent({ save: noRecordInSoManyWords, server: "32", text: "32", atFocus })).toBe("settle");
      expect(saveIntent({ save: record, server: "32", text: "32", atFocus })).toBe("send");
      // However the stored value is spelled.
      expect(saveIntent({ save: noRecord, server: "32", text: "32.0", atFocus })).toBe("settle");
      expect(saveIntent({ save: record, server: "32", text: "32.0", atFocus })).toBe("send");
    }
    // The record decides, not what the box's newest outcome says: the reason on the box may be a
    // refusal the server answered since, or one the client made.
    expect(saveIntent({ save: recorded({ draft: "32", outcome: FAILED(BELOW_SHIPPED) }), server: "32", text: "32", atFocus: null })).toBe("send");
    expect(saveIntent({ save: recorded({ draft: "32", outcome: FAILED(NOT_WHOLE) }), server: "32", text: "32", atFocus: null })).toBe("send");
    // A box with no record settles as before, marked or not.
    expect(saveIntent({ save: save({ draft: "32" }), server: "32", text: "32", atFocus: null })).toBe("settle");
    expect(saveIntent({ save: save({ draft: "32", outcome: SAVED("32") }), server: "32", text: "32", atFocus: null })).toBe("settle");
  });

  it("an unchanged blur skips a box with that record as it does any marked one: rule 3 comes before rule 4", () => {
    const holdsStored = recorded({ draft: "32", outcome: FAILED("no") });
    const holdsTyped = recorded({ draft: "40", outcome: FAILED("no") });
    expect(saveIntent({ save: holdsStored, server: "32", text: "32", atFocus: "32" })).toBe("skip");
    expect(saveIntent({ save: holdsStored, server: "32", text: "32", atFocus: "32.0" })).toBe("skip");
    expect(saveIntent({ save: holdsTyped, server: "32", text: "40", atFocus: "40" })).toBe("skip");
    // Enter carries no at-focus text: the typed value is retried.
    expect(saveIntent({ save: holdsTyped, server: "32", text: "40", atFocus: null })).toBe("send");
  });

  it("while a save is in flight the record is not consulted: rule 1 decides", () => {
    const restoring = recorded({ draft: "32", pending: OUT(2, "32"), outcome: FAILED("no") });
    expect(saveIntent({ save: restoring, server: "32", text: "32", atFocus: null })).toBe("skip");
    expect(saveIntent({ save: restoring, server: "32", text: "40", atFocus: null })).toBe("send");
  });

  it("a box with no draft that carries the record: Enter sends the stored value it shows, and a blur sends nothing", () => {
    // What an unanswered failure of an older attempt leaves when the box held no text of its own.
    const shown = recorded({ outcome: FAILED("Failed to fetch") });
    expect(saveIntent({ save: shown, server: "32", text: "32", atFocus: null })).toBe("send");
    expect(saveIntent({ save: shown, server: "32", text: "32.0", atFocus: null })).toBe("send");
    // Nobody has typed in a box with no draft, so leaving it sends nothing, whatever it held when
    // focus arrived: a payload can change what it shows with no focus event (rule 2, before rule 3).
    for (const atFocus of ["32", "32.0", "40", ""]) {
      expect(saveIntent({ save: shown, server: "32", text: "32", atFocus })).toBe("skip");
    }
    // With no record, a box with no draft that shows the stored value sends nothing on Enter either.
    for (const none of [undefined, save({ outcome: SAVED("32") }), explicitlyNone({ outcome: FAILED("no") })]) {
      expect(saveIntent({ save: none, server: "32", text: "32", atFocus: null })).toBe("skip");
      expect(saveIntent({ save: none, server: "32", text: "32", atFocus: "40" })).toBe("skip");
    }
  });
});

describe("restoreIntent", () => {
  it("saves the stored value while the box records that a save of it went unanswered", () => {
    expect(restoreIntent(recorded({ draft: "40", outcome: FAILED("Failed to fetch") }))).toBe("send");
    // Whatever the box holds by now and whatever its newest outcome says: the stored value under a
    // refusal the server answered to the restore-save, a typo the client refused, text typed since.
    expect(restoreIntent(recorded({ draft: "32", outcome: FAILED(BELOW_SHIPPED) }))).toBe("send");
    expect(restoreIntent(recorded({ draft: "4o", outcome: FAILED(NOT_WHOLE) }))).toBe("send");
    expect(restoreIntent(recorded({ draft: "4", outcome: FAILED("Failed to fetch") }))).toBe("send");
    // No text of its own at all: the stored value on screen, marked for an older save that was lost.
    expect(restoreIntent(recorded({ outcome: FAILED("Failed to fetch") }))).toBe("send");
  });

  it("is local where no save of the box went unanswered: after a refusal the server answered, or one the client made", () => {
    expect(restoreIntent(save({ draft: "20", outcome: FAILED("no") }))).toBe("clear");
    expect(restoreIntent(explicitlyNone({ draft: "20", outcome: FAILED("no") }))).toBe("clear");
    expect(restoreIntent(save({ draft: "4o", outcome: FAILED(NOT_WHOLE) }))).toBe("clear");
  });

  it("is local for a box that is not marked Not saved at all", () => {
    expect(restoreIntent(undefined)).toBe("clear");
    expect(restoreIntent(save({ draft: "4" }))).toBe("clear");
    expect(restoreIntent(save({ draft: "40", outcome: SAVED("40") }))).toBe("clear");
    expect(restoreIntent(save({ draft: "40", pending: OUT(1, "40") }))).toBe("clear");
  });

  it("does not consult a save in flight: the control is disabled while one is out", () => {
    expect(restoreIntent(recorded({ draft: "32", pending: OUT(2, "32"), outcome: FAILED("no") }))).toBe("send");
    expect(restoreIntent(recorded({ draft: "3", pending: OUT(2, "32") }))).toBe("send");
    expect(restoreIntent(save({ draft: "20", pending: OUT(2, "20"), outcome: FAILED("no") }))).toBe("clear");
  });
});

describe("typed", () => {
  it("records the text as the draft", () => {
    expect(typed(NO_FIELD_SAVES, QTY, "4").get(QTY)).toEqual(save({ draft: "4" }));
  });

  it("clears a Saved outcome and, with nothing in flight, keeps a Not saved one", () => {
    expect(typed(of({ [QTY]: save({ outcome: SAVED("40") }) }), QTY, "41").get(QTY)).toEqual(save({ draft: "41" }));
    expect(typed(of({ [QTY]: save({ draft: "20", outcome: FAILED("no") }) }), QTY, "21").get(QTY))
      .toEqual(save({ draft: "21", outcome: FAILED("no") }));
  });

  it("keeps the record that a save went unanswered, beside the Not saved outcome", () => {
    const next = typed(of({ [QTY]: recorded({ draft: "40", outcome: FAILED("Failed to fetch") }) }), QTY, "32").get(QTY);
    expect(next).toEqual(recorded({ draft: "32", outcome: FAILED("Failed to fetch") }));
    // And writes none where there was none.
    expect(typed(of({ [QTY]: save({ draft: "20", outcome: FAILED("no") }) }), QTY, "21").get(QTY))
      .toEqual(save({ draft: "21", outcome: FAILED("no") }));
  });

  it("leaves a save in flight as it is, and other keys alone", () => {
    const cur = of({ [QTY]: save({ draft: "40", pending: OUT(1, "40") }), [WEIGHT]: save({ draft: "5" }) });
    const next = typed(cur, QTY, "45");
    expect(next.get(QTY)).toEqual(save({ draft: "45", pending: OUT(1, "40") }));
    expect(next.get(WEIGHT)).toBe(cur.get(WEIGHT));
  });

  it("clears a Not saved outcome while a save is in flight", () => {
    expect(typed(of({ [QTY]: save({ draft: "20", pending: OUT(2, "20"), outcome: FAILED("no") }) }), QTY, "25").get(QTY))
      .toEqual(save({ draft: "25", pending: OUT(2, "20") }));
  });

  it("while a save is in flight it clears the outcome and keeps the record: a key says nothing about the server", () => {
    expect(typed(of({ [QTY]: recorded({ draft: "32", pending: OUT(2, "32"), outcome: FAILED("no") }) }), QTY, "33").get(QTY))
      .toEqual(recorded({ draft: "33", pending: OUT(2, "32") }));
    // The next key keeps it too, with no outcome left to keep beside it.
    expect(typed(of({ [QTY]: recorded({ draft: "33", pending: OUT(2, "32") }) }), QTY, "3").get(QTY))
      .toEqual(recorded({ draft: "3", pending: OUT(2, "32") }));
  });

  it("returns the same Map when the text is already the draft", () => {
    const cur = of({ [QTY]: save({ draft: "4" }) });
    expect(typed(cur, QTY, "4")).toBe(cur);
    const withRecord = of({ [QTY]: recorded({ draft: "4", outcome: FAILED("no") }) });
    expect(typed(withRecord, QTY, "4")).toBe(withRecord);
  });

  it("never writes into the Map it was given", () => {
    const cur = of({ [QTY]: save({ draft: "4" }) });
    typed(cur, QTY, "40");
    typed(NO_FIELD_SAVES, QTY, "4");
    expect(cur.get(QTY)).toEqual(save({ draft: "4" }));
    expect(NO_FIELD_SAVES.size).toBe(0);
  });
});

describe("settled", () => {
  it("drops a bare draft, and a Not saved entry with its draft", () => {
    expect(settled(of({ [QTY]: save({ draft: "32" }) }), QTY).has(QTY)).toBe(false);
    expect(settled(of({ [QTY]: save({ draft: "32", outcome: FAILED("no") }) }), QTY).has(QTY)).toBe(false);
    expect(settled(of({ [QTY]: explicitlyNone({ draft: "32", outcome: FAILED("no") }) }), QTY).has(QTY)).toBe(false);
  });

  it("never drops an entry that carries the record of an unanswered save: the draft goes, and the mark and the record stay", () => {
    // `saveIntent` does not answer "settle" for such a box. It is asked from the render on screen,
    // though, and an older attempt's lost answer can set the record between that render and the
    // blur. The entry must outlive that: the box shows the stored value, still Not saved, and
    // Restore still sends.
    const next = settled(of({ [QTY]: recorded({ draft: "32.0", outcome: FAILED("no") }) }), QTY);
    expect(next.get(QTY)).toEqual(recorded({ outcome: FAILED("no") }));
    expect(fieldView(next.get(QTY), "32")).toEqual({ text: "32", mark: "not-saved", message: "no", saving: false });
    expect(restoreIntent(next.get(QTY))).toBe("send");
    expect(anyNotSaved(next, serverValues([LEAD]))).toBe(true);
    // Already so: the same Map.
    expect(settled(next, QTY)).toBe(next);
  });

  it("keeps a Saved outcome, with no draft", () => {
    expect(settled(of({ [QTY]: save({ draft: "40", outcome: SAVED("40") }) }), QTY).get(QTY))
      .toEqual(save({ outcome: SAVED("40") }));
  });

  it("keeps a save in flight", () => {
    expect(settled(of({ [QTY]: save({ draft: "32", pending: OUT(1, "40") }) }), QTY).get(QTY))
      .toEqual(save({ pending: OUT(1, "40") }));
  });

  it("an entry it keeps, keeps the record that a save went unanswered", () => {
    expect(settled(of({ [QTY]: recorded({ draft: "32", pending: OUT(2, "40") }) }), QTY).get(QTY))
      .toEqual(recorded({ pending: OUT(2, "40") }));
  });

  it("returns the same Map when there is nothing to settle", () => {
    expect(settled(NO_FIELD_SAVES, QTY)).toBe(NO_FIELD_SAVES);
    const cur = of({ [QTY]: save({ outcome: SAVED("40") }) });
    expect(settled(cur, QTY)).toBe(cur);
  });
});

describe("cleared", () => {
  it("drops the entry whatever it holds, and no other", () => {
    const cur = of({ [QTY]: save({ draft: "20", outcome: FAILED("no") }), [WEIGHT]: save({ draft: "5" }) });
    const next = cleared(cur, QTY);
    expect([...next.keys()]).toEqual([WEIGHT]);
    expect(cur.has(QTY)).toBe(true);
  });

  it("returns the same Map when there is no entry", () => {
    expect(cleared(NO_FIELD_SAVES, QTY)).toBe(NO_FIELD_SAVES);
  });

  it("never drops an entry that carries the record of an unanswered save: the box goes back to the stored value, still Not saved", () => {
    // `restoreIntent` answers "send" for such a box, so Restore does not ask for this. It is asked
    // from the render on screen, though, and an older attempt's lost answer can set the record
    // between that render and the click. The entry must outlive that click, and the next sends.
    const next = cleared(of({ [QTY]: recorded({ draft: "45", outcome: FAILED("no") }), [WEIGHT]: save({ draft: "5" }) }), QTY);
    expect(next.get(QTY)).toEqual(recorded({ outcome: FAILED("no") }));
    expect(fieldView(next.get(QTY), "32")).toEqual({ text: "32", mark: "not-saved", message: "no", saving: false });
    expect(restoreIntent(next.get(QTY))).toBe("send");
    expect(anyNotSaved(next, serverValues([LEAD]))).toBe(true);
    expect(next.get(WEIGHT)).toEqual(save({ draft: "5" }));
    // Already so: the same Map. And an entry with a record spelled out as absent goes as any does.
    expect(cleared(next, QTY)).toBe(next);
    expect(cleared(of({ [QTY]: explicitlyNone({ draft: "45", outcome: FAILED("no") }) }), QTY).has(QTY)).toBe(false);
  });
});

describe("dispatched", () => {
  it("records the sent text as the draft and as the attempt in flight", () => {
    expect(dispatched(NO_FIELD_SAVES, QTY, "40", 7).get(QTY)).toEqual(save({ draft: "40", pending: OUT(7, "40") }));
  });

  it("clears a Saved outcome and keeps a Not saved one until this attempt settles", () => {
    expect(dispatched(of({ [QTY]: save({ outcome: SAVED("40") }) }), QTY, "45", 2).get(QTY))
      .toEqual(save({ draft: "45", pending: OUT(2, "45") }));
    expect(dispatched(of({ [QTY]: save({ draft: "20", outcome: FAILED("no") }) }), QTY, "20", 2).get(QTY))
      .toEqual(save({ draft: "20", pending: OUT(2, "20"), outcome: FAILED("no") }));
  });

  it("keeps the record that a save went unanswered, whatever text goes out: sending again is not an answer", () => {
    // A restore-save: the stored value goes out over the typed one.
    expect(dispatched(of({ [QTY]: recorded({ draft: "40", outcome: FAILED("Failed to fetch") }) }), QTY, "32", 2).get(QTY))
      .toEqual(recorded({ draft: "32", pending: OUT(2, "32"), outcome: FAILED("Failed to fetch") }));
    // Over an attempt still out, with a key typed since and so no outcome beside the record.
    expect(dispatched(of({ [QTY]: recorded({ draft: "3", pending: OUT(2, "32") }) }), QTY, "3", 3).get(QTY))
      .toEqual(recorded({ draft: "3", pending: OUT(3, "3") }));
  });

  it("replaces an older attempt in flight", () => {
    expect(dispatched(of({ [QTY]: save({ draft: "40", pending: OUT(1, "40") }) }), QTY, "45", 2).get(QTY))
      .toEqual(save({ draft: "45", pending: OUT(2, "45") }));
  });
});

describe("landed", () => {
  it("changes nothing, and returns the same Map, for an attempt that is not the pending one", () => {
    const cur = of({ [QTY]: save({ draft: "45", pending: OUT(2, "45") }), [WEIGHT]: save({ draft: "5" }) });
    expect(landed(cur, QTY, 1)).toBe(cur);
    expect(landed(cur, WEIGHT, 2)).toBe(cur);
    expect(landed(cur, fieldKey("gone", "qty"), 2)).toBe(cur);
  });

  it("marks the sent text Saved and keeps the draft when the draft is still the sent text", () => {
    expect(landed(of({ [QTY]: save({ draft: "40", pending: OUT(1, "40") }) }), QTY, 1).get(QTY))
      .toEqual(save({ draft: "40", outcome: SAVED("40") }));
    // Trimmed: a space beside the sent text is not a newer value.
    expect(landed(of({ [WEIGHT]: save({ draft: " 48.5 ", pending: OUT(1, "48.5") }) }), WEIGHT, 1).get(WEIGHT))
      .toEqual(save({ draft: " 48.5 ", outcome: SAVED("48.5") }));
  });

  it("the sent number in another spelling is text typed since the request: no Saved mark", () => {
    // The box held exactly the sent text when the request went out, so each of these was typed since.
    for (const draft of ["48.50", "048.5", "48.500"]) {
      expect(landed(of({ [WEIGHT]: save({ draft, pending: OUT(1, "48.5") }) }), WEIGHT, 1).get(WEIGHT))
        .toEqual(save({ draft }));
    }
    expect(landed(of({ [QTY]: save({ draft: "40.0", pending: OUT(1, "40") }) }), QTY, 1).get(QTY))
      .toEqual(save({ draft: "40.0" }));
  });

  it("marks the sent text Saved when there is no draft", () => {
    expect(landed(of({ [QTY]: save({ pending: OUT(1, "40") }) }), QTY, 1).get(QTY))
      .toEqual(save({ outcome: SAVED("40") }));
  });

  it("replaces a Not saved outcome when the retry lands", () => {
    expect(landed(of({ [QTY]: save({ draft: "20", pending: OUT(2, "20"), outcome: FAILED("no") }) }), QTY, 2).get(QTY))
      .toEqual(save({ draft: "20", outcome: SAVED("20") }));
  });

  it("takes the record that a save went unanswered away: a restore-save that lands leaves Saved and nothing else", () => {
    expect(landed(of({ [QTY]: recorded({ draft: "32", pending: OUT(2, "32"), outcome: FAILED("no") }) }), QTY, 2).get(QTY))
      .toEqual(save({ draft: "32", outcome: SAVED("32") }));
  });

  it("takes it away with the draft moved on too: the server holds what was sent, whatever the box holds now", () => {
    // A refusal the client made of text typed while the save was out stays, with no record.
    expect(landed(of({ [QTY]: recorded({ draft: "4o", pending: OUT(2, "40"), outcome: FAILED(NOT_WHOLE) }) }), QTY, 2).get(QTY))
      .toEqual(save({ draft: "4o", outcome: FAILED(NOT_WHOLE) }));
    // A key typed while it was out leaves a bare draft.
    expect(landed(of({ [QTY]: recorded({ draft: "45", pending: OUT(2, "40") }) }), QTY, 2).get(QTY))
      .toEqual(save({ draft: "45" }));
  });

  it("an attempt that is not the pending one leaves the record where it is", () => {
    const out = of({ [QTY]: recorded({ draft: "32", pending: OUT(3, "32"), outcome: FAILED("no") }) });
    expect(landed(out, QTY, 2)).toBe(out);
    const idle = of({ [QTY]: recorded({ draft: "45", outcome: FAILED("no") }) });
    expect(landed(idle, QTY, 1)).toBe(idle);
  });

  it("with the draft moved on: a Not saved outcome stays, and nothing else is left", () => {
    expect(landed(of({ [QTY]: save({ draft: "4o", pending: OUT(1, "40"), outcome: FAILED("no") }) }), QTY, 1).get(QTY))
      .toEqual(save({ draft: "4o", outcome: FAILED("no") }));
    expect(landed(of({ [QTY]: save({ draft: "45", pending: OUT(1, "40") }) }), QTY, 1).get(QTY))
      .toEqual(save({ draft: "45" }));
  });
});

describe("failed", () => {
  it("a failure the server answered changes nothing, and returns the same Map, for an attempt that is not the pending one", () => {
    const cur = of({ [QTY]: save({ draft: "45", pending: OUT(2, "45") }), [WEIGHT]: save({ draft: "5" }) });
    expect(failed(cur, QTY, 1, "no")).toBe(cur);
    expect(failed(cur, WEIGHT, 2, "no")).toBe(cur);
    expect(failed(cur, fieldKey("gone", "qty"), 2, "no")).toBe(cur);
    expect(failed(cur, QTY, 1, "no", false)).toBe(cur);
    // Whatever the entry holds: a refusal, a Saved mark, or the record of another save.
    for (const held of [
      save({ draft: "45", outcome: FAILED("later") }),
      save({ outcome: SAVED("45") }),
      recorded({ draft: "45", pending: OUT(2, "45"), outcome: FAILED("gone") }),
    ]) {
      const one = of({ [QTY]: held });
      expect(failed(one, QTY, 1, "no")).toBe(one);
    }
  });

  describe("a failure the server did not answer, of an attempt that is not the pending one", () => {
    it("while a newer attempt is out: sets the record and leaves the draft, the attempt in flight and the outcome as they are", () => {
      const cur = of({ [QTY]: save({ draft: "45", pending: OUT(2, "45") }), [WEIGHT]: save({ draft: "5" }) });
      const next = failed(cur, QTY, 1, "gone", true);
      expect(next.get(QTY)).toEqual(recorded({ draft: "45", pending: OUT(2, "45") }));
      expect(next.get(WEIGHT)).toBe(cur.get(WEIGHT));
      // A Not saved outcome the newer attempt is retrying keeps its own words.
      expect(failed(of({ [QTY]: save({ draft: "45", pending: OUT(2, "45"), outcome: FAILED("no") }) }), QTY, 1, "gone", true).get(QTY))
        .toEqual(recorded({ draft: "45", pending: OUT(2, "45"), outcome: FAILED("no") }));
      // A key typed since, and a refusal the page made since, stay as well.
      expect(failed(of({ [QTY]: save({ draft: "4o", pending: OUT(2, "45"), outcome: FAILED(NOT_WHOLE) }) }), QTY, 1, "gone", true).get(QTY))
        .toEqual(recorded({ draft: "4o", pending: OUT(2, "45"), outcome: FAILED(NOT_WHOLE) }));
    });

    it("the record it sets is counted, and the newer attempt's answer finds the entry: a landing takes the record, a refusal leaves it", () => {
      const out = failed(of({ [QTY]: save({ draft: "45", pending: OUT(2, "45") }) }), QTY, 1, "gone", true);
      expect(anyNotSaved(out, serverValues([LEAD]))).toBe(true);
      expect(landed(out, QTY, 2).get(QTY)).toEqual(save({ draft: "45", outcome: SAVED("45") }));
      const refusedAfter = failed(out, QTY, 2, "no");
      expect(refusedAfter.get(QTY)).toEqual(recorded({ draft: "45", outcome: FAILED("no") }));
      expect(restoreIntent(refusedAfter.get(QTY))).toBe("send");
    });

    it("with no attempt out: a Not saved outcome keeps its own words, and the record is set", () => {
      expect(failed(of({ [QTY]: save({ draft: "45", outcome: FAILED("no") }) }), QTY, 1, "gone", true).get(QTY))
        .toEqual(recorded({ draft: "45", outcome: FAILED("no") }));
    });

    it("with no attempt out and no Not saved outcome: the box is made to read Not saved, in this failure's words, and the draft stays", () => {
      // Text typed since: a bare draft.
      expect(failed(of({ [QTY]: save({ draft: "450" }) }), QTY, 1, "gone", true).get(QTY))
        .toEqual(recorded({ draft: "450", outcome: FAILED("gone") }));
      // A Saved mark, waiting for its payload or after it: a box that reads Saved never carries the record.
      expect(failed(of({ [QTY]: save({ draft: "45", outcome: SAVED("45") }) }), QTY, 1, "gone", true).get(QTY))
        .toEqual(recorded({ draft: "45", outcome: FAILED("gone") }));
      const noDraft = failed(of({ [QTY]: save({ outcome: SAVED("45") }) }), QTY, 1, "gone", true);
      expect(noDraft.get(QTY)).toEqual(recorded({ outcome: FAILED("gone") }));
      expect(fieldView(noDraft.get(QTY), "45")).toEqual({ text: "45", mark: "not-saved", message: "gone", saving: false });
    });

    it("with no entry at all: one is made, with no draft, and the box shows the stored value marked Not saved", () => {
      const cur = of({ [WEIGHT]: save({ draft: "5" }) });
      const next = failed(cur, QTY, 1, "gone", true);
      expect(next).not.toBe(cur);
      expect(next.get(QTY)).toEqual(recorded({ outcome: FAILED("gone") }));
      expect(next.get(WEIGHT)).toBe(cur.get(WEIGHT));
      expect(failed(NO_FIELD_SAVES, QTY, 1, "gone", true).get(QTY)).toEqual(recorded({ outcome: FAILED("gone") }));
      expect(fieldView(next.get(QTY), "32")).toEqual({ text: "32", mark: "not-saved", message: "gone", saving: false });
      expect(anyNotSaved(next, serverValues([LEAD]))).toBe(true);
      expect(restoreIntent(next.get(QTY))).toBe("send");
    });

    it("returns the same Map when the entry already says all of it", () => {
      const out = of({ [QTY]: recorded({ draft: "45", pending: OUT(3, "45") }) });
      expect(failed(out, QTY, 1, "gone", true)).toBe(out);
      const idle = of({ [QTY]: recorded({ draft: "45", outcome: FAILED("no") }) });
      expect(failed(idle, QTY, 1, "gone", true)).toBe(idle);
      const made = failed(NO_FIELD_SAVES, QTY, 1, "gone", true);
      expect(failed(made, QTY, 1, "gone", true)).toBe(made);
    });

    it("never writes into the Map it was given", () => {
      const cur = of({ [QTY]: save({ draft: "45", pending: OUT(2, "45") }) });
      failed(cur, QTY, 1, "gone", true);
      failed(NO_FIELD_SAVES, QTY, 1, "gone", true);
      expect(cur.get(QTY)).toEqual(save({ draft: "45", pending: OUT(2, "45") }));
      expect(NO_FIELD_SAVES.size).toBe(0);
    });
  });

  it("records the reason and keeps the text in the box", () => {
    expect(failed(of({ [QTY]: save({ draft: "20", pending: OUT(1, "20") }) }), QTY, 1, "no").get(QTY))
      .toEqual(save({ draft: "20", outcome: FAILED("no") }));
    expect(failed(of({ [QTY]: save({ draft: "25", pending: OUT(1, "20") }) }), QTY, 1, "no").get(QTY))
      .toEqual(save({ draft: "25", outcome: FAILED("no") }));
  });

  it("with no draft, shows the sent text", () => {
    const next = failed(of({ [QTY]: save({ pending: OUT(1, "20") }) }), QTY, 1, "no");
    expect(next.get(QTY)).toEqual(save({ draft: "20", outcome: FAILED("no") }));
    expect(fieldView(next.get(QTY), "32")).toEqual({ text: "20", mark: "not-saved", message: "no", saving: false });
  });

  it("a failure the server did not answer sets the box's record; an answered one sets none, and is written as it has always been", () => {
    const out = of({ [QTY]: save({ draft: "40", pending: OUT(1, "40") }) });
    expect(failed(out, QTY, 1, "gone", true).get(QTY)).toEqual(recorded({ draft: "40", outcome: FAILED("gone") }));
    // Answered is the default, and an entry with no record has no such field at all.
    expect(failed(out, QTY, 1, "no").get(QTY)).toEqual(save({ draft: "40", outcome: FAILED("no") }));
    expect(failed(out, QTY, 1, "no", false).get(QTY)).toEqual(save({ draft: "40", outcome: FAILED("no") }));
    expect(Object.keys(failed(out, QTY, 1, "no").get(QTY) ?? {})).toEqual(["draft", "pending", "outcome"]);
  });

  it("an answered failure replaces the outcome and leaves the record: it is about this request, not the one that was lost", () => {
    // A retry, or a restore-save, that the server refuses.
    expect(failed(of({ [QTY]: recorded({ draft: "32", pending: OUT(2, "32"), outcome: FAILED("gone") }) }), QTY, 2, "no").get(QTY))
      .toEqual(recorded({ draft: "32", outcome: FAILED("no") }));
    // The same when a key typed while it was out had left no outcome to replace.
    expect(failed(of({ [QTY]: recorded({ draft: "3", pending: OUT(2, "32") }) }), QTY, 2, "no").get(QTY))
      .toEqual(recorded({ draft: "3", outcome: FAILED("no") }));
    // A retry of a refused value that gets no answer sets the record.
    expect(failed(of({ [QTY]: save({ draft: "20", pending: OUT(2, "20"), outcome: FAILED("no") }) }), QTY, 2, "gone", true).get(QTY))
      .toEqual(recorded({ draft: "20", outcome: FAILED("gone") }));
  });

  it("the same reason three times, answered, unanswered, answered: the record is set by the second and stays through the third", () => {
    const first = failed(of({ [QTY]: save({ draft: "40", pending: OUT(1, "40") }) }), QTY, 1, "no");
    expect(first.get(QTY)).toEqual(save({ draft: "40", outcome: FAILED("no") }));
    expect(restoreIntent(first.get(QTY))).toBe("clear");
    const second = failed(dispatched(first, QTY, "40", 2), QTY, 2, "no", true);
    expect(second.get(QTY)).toEqual(recorded({ draft: "40", outcome: FAILED("no") }));
    expect(restoreIntent(second.get(QTY))).toBe("send");
    const third = failed(dispatched(second, QTY, "40", 3), QTY, 3, "no");
    expect(third.get(QTY)).toEqual(recorded({ draft: "40", outcome: FAILED("no") }));
    expect(restoreIntent(third.get(QTY))).toBe("send");
  });
});

describe("refused", () => {
  it("records the text and the reason without a request", () => {
    expect(refused(NO_FIELD_SAVES, QTY, "4o", NOT_WHOLE).get(QTY)).toEqual(save({ draft: "4o", outcome: FAILED(NOT_WHOLE) }));
  });

  it("leaves a save in flight untouched", () => {
    expect(refused(of({ [QTY]: save({ draft: "40", pending: OUT(1, "40") }) }), QTY, "4o", NOT_WHOLE).get(QTY))
      .toEqual(save({ draft: "4o", pending: OUT(1, "40"), outcome: FAILED(NOT_WHOLE) }));
  });

  it("returns the same Map when the same text is refused for the same reason", () => {
    const cur = refused(NO_FIELD_SAVES, QTY, "4o", NOT_WHOLE);
    expect(refused(cur, QTY, "4o", NOT_WHOLE)).toBe(cur);
  });

  it("leaves the record that a save went unanswered: no request was made, so nothing was learned about the server", () => {
    const next = refused(of({ [QTY]: recorded({ draft: "40", outcome: FAILED("Failed to fetch") }) }), QTY, "4o", NOT_WHOLE);
    expect(next.get(QTY)).toEqual(recorded({ draft: "4o", outcome: FAILED(NOT_WHOLE) }));
    expect(restoreIntent(next.get(QTY))).toBe("send");
    // With a save still out, too.
    expect(refused(of({ [QTY]: recorded({ draft: "4", pending: OUT(2, "32") }) }), QTY, "4o", NOT_WHOLE).get(QTY))
      .toEqual(recorded({ draft: "4o", pending: OUT(2, "32"), outcome: FAILED(NOT_WHOLE) }));
    // And it writes none where there was none.
    const plain = refused(of({ [QTY]: save({ draft: "20", outcome: FAILED("no") }) }), QTY, "4o", NOT_WHOLE);
    expect(plain.get(QTY)).toEqual(save({ draft: "4o", outcome: FAILED(NOT_WHOLE) }));
    expect(restoreIntent(plain.get(QTY))).toBe("clear");
  });

  it("the same text and the same reason over an entry with the record changes nothing", () => {
    const cur = of({ [QTY]: recorded({ draft: "4o", outcome: FAILED(NOT_WHOLE) }) });
    expect(refused(cur, QTY, "4o", NOT_WHOLE)).toBe(cur);
  });

  it("no record and a false one are the same entry", () => {
    const cur = of({ [QTY]: explicitlyNone({ draft: "4o", outcome: FAILED(NOT_WHOLE) }) });
    expect(refused(cur, QTY, "4o", NOT_WHOLE)).toBe(cur);
  });
});

describe("reconciled", () => {
  const server = serverValues([LEAD]); // L1:qty "32", L1:weight "60"

  it("drops every key the server no longer has, in flight or not", () => {
    const cur = of({
      [fieldKey("L2", "qty")]: save({ draft: "7", pending: OUT(1, "7") }),
      [fieldKey("L2", "weight")]: save({ draft: "0", outcome: FAILED("no") }),
      [QTY]: save({ draft: "4" }),
    });
    expect([...reconciled(cur, server).keys()]).toEqual([QTY]);
  });

  it("clears the draft of a Saved entry the server now shows, and keeps the mark", () => {
    expect(reconciled(of({ [QTY]: save({ draft: "32", outcome: SAVED("32") }) }), server).get(QTY))
      .toEqual(save({ outcome: SAVED("32") }));
    expect(reconciled(of({ [WEIGHT]: save({ draft: "60.00", outcome: SAVED("60.00") }) }), server).get(WEIGHT))
      .toEqual(save({ outcome: SAVED("60.00") }));
  });

  it("drops a Saved entry with no draft once the server contradicts it", () => {
    expect(reconciled(of({ [QTY]: save({ outcome: SAVED("40") }) }), server).has(QTY)).toBe(false);
  });

  it("drops a Saved entry whose waiting draft the server contradicts", () => {
    expect(reconciled(of({ [QTY]: save({ draft: "40", outcome: SAVED("40") }) }), server).has(QTY)).toBe(false);
  });

  it("drops a Not saved entry whose draft is the server's value as text, where no save of the box went unanswered", () => {
    expect(reconciled(of({ [QTY]: save({ draft: "32", outcome: FAILED("no") }) }), server).has(QTY)).toBe(false);
    expect(reconciled(of({ [QTY]: explicitlyNone({ draft: "32", outcome: FAILED("no") }) }), server).has(QTY)).toBe(false);
    // Trimmed: a space beside the server's text is still the server's text.
    expect(reconciled(of({ [WEIGHT]: save({ draft: " 60 ", outcome: FAILED("no") }) }), server).has(WEIGHT)).toBe(false);
  });

  it("keeps a Not saved entry whose draft spells the server's value another way: it may still be being typed", () => {
    for (const draft of ["60.0", "60.00", "060"]) {
      const cur = of({ [WEIGHT]: save({ draft, outcome: FAILED("no") }) });
      expect(reconciled(cur, server)).toBe(cur);
    }
    const qty = of({ [QTY]: save({ draft: "32.0", outcome: FAILED("no") }) });
    expect(reconciled(qty, server)).toBe(qty);
  });

  it("keeps an entry that carries the record of an unanswered save, whatever the payload shows: a payload alone never ends that record", () => {
    // The box's own text, as text and with a space beside it: the payload may be older than the lost write.
    const ownText = of({
      [QTY]: recorded({ draft: "32", outcome: FAILED("Failed to fetch") }),
      [WEIGHT]: recorded({ draft: " 60 ", outcome: FAILED("Failed to fetch") }),
    });
    expect(reconciled(ownText, server)).toBe(ownText);
    // The same value in another spelling, and another value altogether.
    const other = of({
      [QTY]: recorded({ draft: "40", outcome: FAILED("Failed to fetch") }),
      [WEIGHT]: recorded({ draft: "60.0", outcome: FAILED("Failed to fetch") }),
    });
    expect(reconciled(other, server)).toBe(other);
    // No draft: the box shows the stored value, marked for an older save that was lost.
    const shown = of({ [QTY]: recorded({ outcome: FAILED("Failed to fetch") }) });
    expect(reconciled(shown, server)).toBe(shown);
    // With a save out it is left alone as any entry is, with or without a key typed since.
    const out = of({
      [QTY]: recorded({ draft: "32", pending: OUT(2, "32"), outcome: FAILED("no") }),
      [WEIGHT]: recorded({ draft: "6", pending: OUT(3, "60") }),
    });
    expect(reconciled(out, server)).toBe(out);
  });

  it("still drops such an entry when its line has left the order", () => {
    const cur = of({
      [fieldKey("L2", "qty")]: recorded({ draft: "7", outcome: FAILED("Failed to fetch") }),
      [fieldKey("L2", "weight")]: recorded({ outcome: FAILED("Failed to fetch") }),
      [QTY]: recorded({ draft: "32", outcome: FAILED("Failed to fetch") }),
    });
    expect([...reconciled(cur, server).keys()]).toEqual([QTY]);
  });

  it("leaves a bare draft alone, whatever the server shows", () => {
    const same = of({ [QTY]: save({ draft: "32" }) });
    const other = of({ [QTY]: save({ draft: "45" }) });
    expect(reconciled(same, server)).toBe(same);
    expect(reconciled(other, server)).toBe(other);
  });

  it("leaves an entry with a save in flight alone, whatever else it holds", () => {
    const cur = of({
      [QTY]: save({ draft: "32", pending: OUT(2, "32"), outcome: FAILED("no") }),
      [WEIGHT]: save({ pending: OUT(3, "48") }),
    });
    expect(reconciled(cur, server)).toBe(cur);
  });

  it("returns the same Map when nothing changes", () => {
    const cur = of({
      [QTY]: save({ outcome: SAVED("32.0") }),
      [WEIGHT]: save({ draft: "0", outcome: FAILED("no") }),
    });
    expect(reconciled(cur, server)).toBe(cur);
    expect(reconciled(NO_FIELD_SAVES, server)).toBe(NO_FIELD_SAVES);
  });

  it("never writes into the Map it was given", () => {
    const cur = of({ [QTY]: save({ draft: "32", outcome: SAVED("32") }), [fieldKey("L2", "qty")]: save({ draft: "7" }) });
    reconciled(cur, server);
    expect(cur.size).toBe(2);
    expect(cur.get(QTY)).toEqual(save({ draft: "32", outcome: SAVED("32") }));
  });
});

describe("fieldView", () => {
  it("no entry: the server's value, nothing else", () => {
    expect(fieldView(undefined, "32")).toEqual(quiet("32"));
  });

  it("a bare draft: the typed text, no mark", () => {
    expect(fieldView(save({ draft: "4" }), "32")).toEqual(quiet("4"));
  });

  it("a save in flight: the sent text, saving", () => {
    expect(fieldView(save({ draft: "40", pending: OUT(1, "40") }), "32"))
      .toEqual({ text: "40", mark: null, message: null, saving: true });
  });

  it("Saved with the draft still in the box", () => {
    expect(fieldView(save({ draft: "40", outcome: SAVED("40") }), "32")).toEqual(savedView("40"));
  });

  it("Saved with no draft, while the server shows the saved value however it writes it", () => {
    expect(fieldView(save({ outcome: SAVED("48.50") }), "48.5")).toEqual(savedView("48.5"));
  });

  it("no mark for a Saved outcome the box no longer shows", () => {
    expect(fieldView(save({ outcome: SAVED("40") }), "32")).toEqual(quiet("32"));
  });

  it("Not saved: the typed text and the reason", () => {
    expect(fieldView(save({ draft: "20", outcome: FAILED("no") }), "32"))
      .toEqual({ text: "20", mark: "not-saved", message: "no", saving: false });
  });

  it("Not saved with a retry in flight", () => {
    expect(fieldView(save({ draft: "20", pending: OUT(2, "20"), outcome: FAILED("no") }), "32"))
      .toEqual({ text: "20", mark: "not-saved", message: "no", saving: true });
  });

  it("the record that a save went unanswered is not rendered: the box reads as its outcome says", () => {
    expect(fieldView(recorded({ draft: "40", outcome: FAILED("gone") }), "32"))
      .toEqual(fieldView(save({ draft: "40", outcome: FAILED("gone") }), "32"));
    // With its restore-save out: the stored value, still Not saved, saving.
    expect(fieldView(recorded({ draft: "32", pending: OUT(2, "32"), outcome: FAILED("gone") }), "32"))
      .toEqual({ text: "32", mark: "not-saved", message: "gone", saving: true });
    // A key typed while that save is out: no mark, though the box is still counted (`anyNotSaved`).
    expect(fieldView(recorded({ draft: "3", pending: OUT(2, "32") }), "32"))
      .toEqual({ text: "3", mark: null, message: null, saving: true });
  });

  it("Not saved with no draft: the stored value, marked, with the reason", () => {
    // What an unanswered failure of an older attempt leaves on a box that held no text of its own.
    expect(fieldView(recorded({ outcome: FAILED("gone") }), "32"))
      .toEqual({ text: "32", mark: "not-saved", message: "gone", saving: false });
  });
});

describe("anyNotSaved", () => {
  const server = serverValues([LEAD]);

  it("is false with nothing held, and for drafts, saves in flight and Saved marks", () => {
    expect(anyNotSaved(NO_FIELD_SAVES, server)).toBe(false);
    expect(anyNotSaved(of({
      [QTY]: save({ draft: "40", pending: OUT(1, "40") }),
      [WEIGHT]: save({ draft: "48", outcome: SAVED("48") }),
    }), server)).toBe(false);
    expect(anyNotSaved(of({ [QTY]: save({ draft: "4" }) }), server)).toBe(false);
  });

  it("is true for a Not saved field, and stays true through a retry in flight", () => {
    expect(anyNotSaved(of({ [QTY]: save({ draft: "20", outcome: FAILED("no") }) }), server)).toBe(true);
    expect(anyNotSaved(of({ [QTY]: save({ draft: "20", pending: OUT(2, "20"), outcome: FAILED("no") }) }), server)).toBe(true);
  });

  it("counts a box that records an unanswered save, through its restore-save and after that fails", () => {
    expect(anyNotSaved(of({ [QTY]: recorded({ draft: "40", outcome: FAILED("gone") }) }), server)).toBe(true);
    expect(anyNotSaved(of({ [QTY]: recorded({ draft: "32", pending: OUT(2, "32"), outcome: FAILED("gone") }) }), server)).toBe(true);
    // The box shows the stored value and still counts: whether the server holds it is not known.
    expect(anyNotSaved(of({ [QTY]: recorded({ draft: "32", outcome: FAILED("no") }) }), server)).toBe(true);
    expect(anyNotSaved(of({ [QTY]: save({ draft: "32", outcome: FAILED("no") }) }), server)).toBe(true);
  });

  it("counts such a box by its record alone, in the moment it has no Not saved outcome", () => {
    // A key typed while the retry or the restore-save is out cleared the outcome. The box reads no
    // mark for the length of that request, and the section must stay registered through it.
    expect(anyNotSaved(of({ [QTY]: recorded({ draft: "3", pending: OUT(2, "32") }) }), server)).toBe(true);
    // The same entry with no record is text typed over a save in flight, which does not count.
    expect(anyNotSaved(of({ [QTY]: save({ draft: "3", pending: OUT(2, "32") }) }), server)).toBe(false);
    expect(anyNotSaved(of({ [QTY]: explicitlyNone({ draft: "3", pending: OUT(2, "32") }) }), server)).toBe(false);
  });

  it("does not count a Not saved field on a line the server no longer has", () => {
    expect(anyNotSaved(of({ [fieldKey("L2", "qty")]: save({ draft: "0", outcome: FAILED("no") }) }), server)).toBe(false);
    expect(anyNotSaved(of({ [fieldKey("L2", "qty")]: recorded({ draft: "7", pending: OUT(1, "7") }) }), server)).toBe(false);
  });
});

describe("unansweredStatus", () => {
  // R13: a request got no answer the page can trust when no response arrived or the server
  // answered 5xx. Since #547 a 2xx whose body could not be read is one too (owner ruling
  // 2026-10-18): `UnreadableAnswerError` carries no `status`, so it reaches this as null, as no
  // response does. Every other status is an answer: the server refused and wrote nothing.
  it.each([null, 500, 502, 504])("is true for %s", (status) => {
    expect(unansweredStatus(status)).toBe(true);
  });

  it.each([499, 404, 409, 400])("is false for %s", (status) => {
    expect(unansweredStatus(status)).toBe(false);
  });
});

describe("retained", () => {
  it("keeps only the ids still live", () => {
    expect([...retained(new Set(["L1", "L2", "L3"]), ["L3", "L1", "L9"])]).toEqual(["L1", "L3"]);
    expect(retained(new Set(["L1"]), []).size).toBe(0);
  });

  it("returns the same Set when nothing was dropped", () => {
    const ids: ReadonlySet<string> = new Set(["L1", "L2"]);
    expect(retained(ids, ["L1", "L2", "L3"])).toBe(ids);
    expect(retained(ids, new Set(["L2", "L1"]))).toBe(ids);
    const none: ReadonlySet<string> = new Set();
    expect(retained(none, [])).toBe(none);
  });

  it("never writes into the Set it was given", () => {
    const ids = new Set(["L1", "L2"]);
    retained(ids, ["L1"]);
    expect([...ids]).toEqual(["L1", "L2"]);
  });
});
