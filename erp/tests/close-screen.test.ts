// The Month-End Close screen's decisions, in a client-safe leaf (#649, the 2026-10-22 review's P10):
// which year the Year box has committed, which figures belong to the committed period, what the
// Close button's title is, and which message belongs to the period or row it was raised for. The
// screen used to key none of this: the Year box committed every keystroke through `Number()`
// (`""` is 0, `202` on the way to `2026` is a year), and a month switch left the previous period's
// schedule under the new heading with Close enabled while the reads were out, or for good after a
// failed read. Each comparison here is mutation-proven: break it and a case reds.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callsBareIdentifier } from "./helpers/ts-parse";
import { closeMonthFrom, closeTitle, closeYearFrom, messageFor, periodFigures, reversalWarning } from "@/lib/close-screen";
import ts from "typescript";
import { vi } from "vitest";
import { all, run } from "./helpers/source-lift";

const period = { year: 2026, month: 9 };
const other = { year: 2026, month: 8 };
const schedule = (variance: number) => ({
  beginningAr: 0, invoicedTotal: 0, creditTotal: 0, paymentTotal: 0,
  discountTotal: 0, writeOffTotal: 0, endingAr: 0, agingEndingAr: 0, variance,
});
const prelim = (p: { year: number; month: number }, variance = 0) =>
  ({ ...p, schedule: schedule(variance), unpostedBatchCount: 0, alreadyClosed: false });
const gaps = (p: { year: number; month: number }, n = 0) =>
  ({ ...p, gaps: Array.from({ length: n }, (_, i) => ({ kind: "step-code" as const, id: `g${i}`, label: `Gap ${i}`, href: "/x" })) });

describe("closeYearFrom and closeMonthFrom (ruling 19's rule, the screen's bounds)", () => {
  it("commits a whole year inside the close bounds and nothing else", () => {
    expect(closeYearFrom("2026")).toBe(2026);
    expect(closeYearFrom(" 2000 ")).toBe(2000);
    expect(closeYearFrom("9999")).toBe(9999);
    for (const text of ["", "0", "2", "202", "1999", "10000", "2e3", "2026.", "-2026", "abc", null, undefined]) {
      expect(closeYearFrom(text)).toBeNull();
    }
  });
  it("commits a month from 1 to 12 and nothing else", () => {
    expect(closeMonthFrom("1")).toBe(1);
    expect(closeMonthFrom("12")).toBe(12);
    for (const text of ["", "0", "13", "1e1", "7.0", null]) expect(closeMonthFrom(text)).toBeNull();
  });
});

describe("periodFigures: only the committed period's own payloads are shown", () => {
  it("is uncommitted with no period, whatever is held", () => {
    expect(periodFigures({ preliminary: prelim(period), readiness: gaps(period), readError: null }, null))
      .toEqual({ status: "uncommitted", preliminary: null, gaps: null, message: null });
  });
  it("is loading until BOTH payloads carry the period, and shows neither until then", () => {
    expect(periodFigures({ preliminary: prelim(other), readiness: gaps(other), readError: null }, period))
      .toEqual({ status: "loading", preliminary: null, gaps: null, message: null });
    expect(periodFigures({ preliminary: prelim(period), readiness: gaps(other), readError: null }, period).status).toBe("loading");
    expect(periodFigures({ preliminary: null, readiness: null, readError: null }, period).status).toBe("loading");
  });
  it("is ready with the period's own schedule and gaps", () => {
    const f = periodFigures({ preliminary: prelim(period, 12.5), readiness: gaps(period, 2), readError: null }, period);
    expect(f.status).toBe("ready");
    expect(f.preliminary?.schedule.variance).toBe(12.5);
    expect(f.gaps).toHaveLength(2);
    expect(f.message).toBeNull();
  });
  it("an error held for THIS period hides its figures, even ones that match; one for another period does not", () => {
    const err = { ...period, message: "Could not load" };
    const held = { preliminary: prelim(period), readiness: gaps(period), readError: err };
    expect(periodFigures(held, period)).toEqual({ status: "error", preliminary: null, gaps: null, message: "Could not load" });
    expect(periodFigures({ ...held, readError: { ...other, message: "old" } }, period).status).toBe("ready");
  });
});

describe("closeTitle: the Close button's reason, in order", () => {
  const open = { allowed: true, disabled: false, title: undefined };
  const shut = (title: string) => ({ allowed: false, disabled: true, title });
  const base = {
    editGate: open, closeDoGate: open, closing: false, priorOk: true,
    figures: periodFigures({ preliminary: prelim(period), readiness: gaps(period), readError: null }, period),
  };
  it("is undefined when everything allows a close", () => {
    expect(closeTitle(base)).toBeUndefined();
  });
  it("names a missing permission first", () => {
    expect(closeTitle({ ...base, editGate: shut("Requires receivables.edit") })).toBe("Requires receivables.edit");
    expect(closeTitle({ ...base, closeDoGate: shut("Requires close_ar_period") })).toBe("Requires close_ar_period");
  });
  it("holds Close while the year is uncommitted, while the figures are loading, and after a failed read", () => {
    expect(closeTitle({ ...base, figures: periodFigures({ preliminary: null, readiness: null, readError: null }, null) }))
      .toBe("Enter a year from 2000 to 9999");
    expect(closeTitle({ ...base, figures: periodFigures({ preliminary: prelim(other), readiness: gaps(other), readError: null }, period) }))
      .toBe("Loading…");
    expect(closeTitle({ ...base, figures: periodFigures({ preliminary: prelim(period), readiness: gaps(period), readError: { ...period, message: "boom" } }, period) }))
      .toBe("The schedule for this period could not be loaded");
  });
  it("names a non-zero variance, then the prior month, then the close in flight", () => {
    expect(closeTitle({ ...base, figures: periodFigures({ preliminary: prelim(period, 12.5), readiness: gaps(period), readError: null }, period) }))
      .toBe("Variance must be zero to close (currently $12.50)");
    expect(closeTitle({ ...base, priorOk: false })).toBe("The prior month must be closed first");
    expect(closeTitle({ ...base, closing: true })).toBe("Closing…");
  });
});

describe("messageFor: a message is shown for the period it was raised for, and no other", () => {
  it("answers the text for the same period and null otherwise", () => {
    expect(messageFor({ ...period, text: "Variance 409" }, period)).toBe("Variance 409");
    expect(messageFor({ ...period, text: "Variance 409" }, other)).toBeNull();
    expect(messageFor({ ...period, text: "Variance 409" }, null)).toBeNull();
    expect(messageFor(null, period)).toBeNull();
  });
});

// The wiring: the screen asks the leaf, and the two shapes the leaf replaced are gone from it.
describe("Close.tsx reads the leaf (#649)", () => {
  const src = readFileSync(join(process.cwd(), "src/app/receivables/close/Close.tsx"), "utf8");
  it("calls closeYearFrom, closeMonthFrom, periodFigures, messageFor and the leaf's closeTitle", () => {
    for (const name of ["closeYearFrom", "closeMonthFrom", "periodFigures", "messageFor", "closeButtonTitle"]) {
      expect(callsBareIdentifier(src, name, "Close.tsx"), name).toBe(true);
    }
  });
  it("commits no year through Number(), asks no confirm() before its one prompt, and mounts the shared PanelMessage", () => {
    expect(src).not.toMatch(/Number\(e\.target\.value\)/);
    expect(src).not.toMatch(/\bconfirm\(/);
    expect((src.match(/<PanelMessage /g) ?? []).length).toBe(2);
    expect(src).toContain('from "@/components/PanelMessage"');
  });
});

// Owner ruling R25 (#705), worded by the owner 2026-11-02: an export that reverses events already
// exported asks first, naming how many; one event reads in the singular, and none asks nothing.
describe("the warning before an export that reverses (R25)", () => {
  it("names the count, singular for one, and asks nothing at zero", () => {
    expect(reversalWarning(0)).toBeNull();
    expect(reversalWarning(1)).toEqual({ title: "Reverse earlier postings?",
      body: "This export reverses 1 event already exported and posts it again.", confirm: "Export GL summary" });
    expect(reversalWarning(3)).toEqual({ title: "Reverse earlier postings?",
      body: "This export reverses 3 events already exported and posts them again.", confirm: "Export GL summary" });
  });

  /** Close.tsx's own `doExport`, run over stand-ins: it answers the requests it sent and the
   *  questions it asked. */
  async function exportWith(reversals: number | Error, answer: boolean, mountedAfter = true) {
    const file = join(process.cwd(), "src/app/receivables/close/Close.tsx");
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found = all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === "doExport");
    expect(found).toHaveLength(1);
    const sent: string[] = []; const asked: unknown[] = []; const messages: unknown[] = [];
    const mounted = { current: true };
    const api = vi.fn(async (path: string, init?: { method?: string }) => {
      sent.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/reversals")) { if (reversals instanceof Error) throw reversals; return { reversals }; }
      return {};
    });
    const askConfirm = vi.fn(async (q: unknown) => { asked.push(q); mounted.current = mountedAfter; return answer; });
    const doExport = run<(id: string) => Promise<void>>(found[0].getText(source), {
      api, askConfirm, reversalWarning, mounted, setExportingId: vi.fn(), setRefresh: vi.fn(),
      setRowMessage: (m: unknown) => messages.push(m),
    });
    await doExport("p1");
    return { sent, asked, messages };
  }

  it("with nothing to reverse, exports without asking", async () => {
    const { sent, asked } = await exportWith(0, true);
    expect(asked).toEqual([]);
    expect(sent).toEqual(["GET /api/receivables/close/p1/reversals", "POST /api/receivables/close/p1/export"]);
  });

  it("with events to reverse, asks in the owner's words and exports only on the answer", async () => {
    const yes = await exportWith(2, true);
    expect(yes.asked).toEqual([reversalWarning(2)]);
    expect(yes.sent).toEqual(["GET /api/receivables/close/p1/reversals", "POST /api/receivables/close/p1/export"]);
    const no = await exportWith(2, false);
    expect(no.sent).toEqual(["GET /api/receivables/close/p1/reversals"]);
    const gone = await exportWith(2, true, false);
    expect(gone.sent).toEqual(["GET /api/receivables/close/p1/reversals"]);
  });

  it("a refused count shows under the row and exports nothing", async () => {
    const { sent, asked, messages } = await exportWith(new Error("Cannot export August 2026: 1 GL account gap must be resolved first. Pick August 2026 above to see it."), true);
    expect(asked).toEqual([]);
    expect(sent).toEqual(["GET /api/receivables/close/p1/reversals"]);
    expect(messages.at(-1)).toEqual({ id: "p1", text: "Cannot export August 2026: 1 GL account gap must be resolved first. Pick August 2026 above to see it." });
  });
});
