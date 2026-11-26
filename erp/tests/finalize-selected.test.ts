import { describe, expect, it } from "vitest";
import {
  finalizeConfirmParts, finalizeResultText, finalizeTickable, LOST_FINALIZE, registerTickable, runSelectedFinalizes,
} from "@/lib/finalize-selected";

// #1057 ruling 2b (owner, 2026-11-26) and the build answers of the same day: Finalize selected sends
// one finalize per ticked draft in the list's order, through the single Finalize's route, shows each
// refusal beside its row and carries on, and stops after the request in flight once the page has
// gone. A lost answer is R13's (`unansweredStatus`): a 5xx or no response. Each guard below is
// proven by changing it and watching its case go red.

const ok = () => Response.json({ invoice: {}, warnings: [] }, { status: 200 });
const refused = (status: number, body: unknown) => Response.json(body, { status });

async function run(ids: string[], answers: Record<string, Response | Error> = {}, stillOpen = () => true) {
  const posted: string[] = [];
  const result = await runSelectedFinalizes(ids, async (id) => {
    posted.push(id);
    const answer = answers[id] ?? ok();
    if (answer instanceof Error) throw answer;
    return answer;
  }, stillOpen);
  return { posted, result };
}

describe("runSelectedFinalizes (#1057)", () => {
  it("finalizes each id in turn, in the order given", async () => {
    const { posted, result } = await run(["c", "a", "b"]);
    expect(posted).toEqual(["c", "a", "b"]);
    expect(result).toEqual({ finalized: ["c", "a", "b"], failures: new Map(), warnings: new Map(), stopped: false });
  });

  it("shows a refusal beside its row in the server's words and carries on", async () => {
    const sentence = "Order #1002 is Partially shipped — ship the rest or close the line short, then finalize";
    const { posted, result } = await run(["a", "b", "c"], { b: refused(400, { error: sentence }) });
    expect(posted).toEqual(["a", "b", "c"]);
    expect(result.finalized).toEqual(["a", "c"]);
    expect(result.failures).toEqual(new Map([["b", sentence]]));
  });

  // Owner ruling 2026-11-26 on #1063 ("Yes, show warnings"): a finalized row keeps the warnings its
  // answer carried, the route's own words, as the invoice page shows them.
  it("keeps a finalized row's warnings from its answer, in the server's words, and none for a row with none", async () => {
    const needsPrice = "Line 2 (Austemper) needs a price";
    const noGl = "Line 3 has no GL account";
    const { result } = await run(["a", "b", "c"], {
      a: Response.json({ invoice: {}, warnings: [needsPrice, noGl] }),
      c: Response.json({ invoice: {}, warnings: [] }),
    });
    expect(result.finalized).toEqual(["a", "b", "c"]);
    expect(result.warnings).toEqual(new Map([["a", [needsPrice, noGl]]]));
    expect(result.failures).toEqual(new Map());
  });

  it("counts a 2xx whose body cannot be read as finalized, with no warnings", async () => {
    const { result } = await run(["a"], { a: new Response("not json", { status: 200 }) });
    expect(result.finalized).toEqual(["a"]);
    expect(result.warnings).toEqual(new Map());
    expect(result.failures).toEqual(new Map());
  });

  it("falls back to the status when a refusal carries no sentence", async () => {
    const { result } = await run(["a"], { a: new Response("nope", { status: 409 }) });
    expect(result.failures).toEqual(new Map([["a", "Finalize failed (409)"]]));
  });

  it("calls a 5xx or a request with no answer a lost answer: it may have finalized", async () => {
    const { result } = await run(["a", "b", "c"], { a: refused(500, { error: "boom" }), b: new Error("network") });
    expect(result.finalized).toEqual(["c"]);
    expect(result.failures).toEqual(new Map([["a", LOST_FINALIZE], ["b", LOST_FINALIZE]]));
    expect(LOST_FINALIZE).toBe("It may have finalized, but the answer was lost. Reload to see.");
  });

  it("asks before every request whether the page is still open, and stops there", async () => {
    let asked = 0;
    const { posted, result } = await run(["a", "b", "c"], {}, () => (asked += 1) <= 1);
    expect(posted).toEqual(["a"]);
    expect(result).toEqual({ finalized: ["a"], failures: new Map(), warnings: new Map(), stopped: true });
    const none = await run(["a"], {}, () => false);
    expect(none.posted).toEqual([]);
    expect(none.result.stopped).toBe(true);
  });
});

describe("the register's boxes (#1057)", () => {
  const row = (status: "DRAFT" | "FINALIZED", printedAt: string | null = null, orderVoided = false) => ({ status, printedAt, orderVoided });

  it("gives a draft on a live order a Finalize selected box, and none on a voided order", () => {
    expect(finalizeTickable(row("DRAFT"))).toBe(true);
    expect(finalizeTickable(row("DRAFT", "2026-11-01T00:00:00.000Z"))).toBe(true); // a printed draft still finalizes
    expect(finalizeTickable(row("DRAFT", null, true))).toBe(false);
    expect(finalizeTickable(row("FINALIZED"))).toBe(false);
  });

  it("draws a box for a draft or a finalized row not printed since, and none for a printed finalized row", () => {
    expect(registerTickable(row("DRAFT"))).toBe(true);
    expect(registerTickable(row("FINALIZED"))).toBe(true);
    expect(registerTickable(row("FINALIZED", "2026-11-01T00:00:00.000Z"))).toBe(false);
    expect(registerTickable(row("FINALIZED", null, true))).toBe(false);
  });
});

describe("Finalize selected's words (#1057)", () => {
  it("confirms one draft in the singular and several in the plural", () => {
    expect(finalizeConfirmParts(1)).toEqual({
      title: "Finalize 1 draft?", body: "It gets the checks Finalize runs, and if it cannot be finalized its row says why.",
    });
    expect(finalizeConfirmParts(4)).toEqual({
      title: "Finalize 4 drafts?", body: "Each gets the checks Finalize runs, and a draft that cannot be finalized says why on its row.",
    });
  });

  it("closes the run with the count finalized of the count sent", () => {
    expect(finalizeResultText(2, 3)).toBe("Finalized 2 of 3.");
  });
});
