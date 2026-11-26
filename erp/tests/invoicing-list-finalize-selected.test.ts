import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import {
  finalizeConfirmParts, finalizeResultText, finalizeTickable, LOST_FINALIZE, runSelectedFinalizes,
} from "@/lib/finalize-selected";
import { pruneToTickable } from "@/lib/print-selected";
import { callback, runNode, source } from "./helpers/lift-callback";

// #1057 ruling 2b (owner, 2026-11-26) and the build answers of the same day: the Invoicing list's
// Finalize selected. tests/finalize-selected.test.ts proves the run's rules on the leaf; this file
// proves the page is wired to them, the page's own `finalizeSelected` lifted out of its source over
// recording stand-ins (the invoicing-list-print-selected precedent, whose header says how).

const LIST = "app/invoicing/InvoicingList.tsx";

type Row = { id: string; status: "DRAFT" | "FINALIZED"; printedAt: string | null; orderVoided: boolean };

/** The register as it stands: two drafts, a finalized row not yet printed, and a draft on a voided
 *  order, which draws no box. */
const ROWS: Row[] = [
  { id: "d1", status: "DRAFT", printedAt: null, orderVoided: false },
  { id: "f1", status: "FINALIZED", printedAt: null, orderVoided: false },
  { id: "d2", status: "DRAFT", printedAt: null, orderVoided: false },
  { id: "dv", status: "DRAFT", printedAt: null, orderVoided: true },
];

/** The page's own `finalizeRows` initializer over a case's rows and ticks. */
function finalizeRowsOf(invoices: Row[], printTicked: Set<string>): Row[] {
  const file = source(LIST);
  let initializer: ts.Expression | undefined;
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "finalizeRows") initializer = node.initializer;
    ts.forEachChild(node, walk);
  };
  walk(file);
  if (!initializer) throw new Error("Missing production InvoicingList.finalizeRows");
  return runNode<Row[]>(initializer, file, { invoices, printTicked, finalizeTickable });
}

const refusedAnswer = (sentence: string) => Response.json({ error: sentence }, { status: 400 });

function page(ticks: string[] = ["d1", "f1", "d2", "dv"], options: { confirmed?: boolean; printing?: boolean; finalizing?: boolean } = {}) {
  const log: string[] = [];
  const answers: Record<string, () => Response> = {};
  const open = { current: true };
  // After the reload, the finalized drafts are finalized rows not yet printed: still tickable.
  const tickableRef = { current: new Set(["d1", "f1", "d2"]) };
  const script: { reload: Set<string> | null } = { reload: new Set(["d1", "f1", "d2"]) };
  const loadInvoicesRef = { current: vi.fn(async () => { log.push("reload"); if (script.reload) tickableRef.current = script.reload; }) };
  const askConfirm = vi.fn(async (q: { title: string; body: string; confirm: string }) => {
    log.push(`confirm ${q.title} ${q.body} [${q.confirm}]`);
    return options.confirmed ?? true;
  });
  const trackedFetch = vi.fn(async (path: string, init: RequestInit) => {
    log.push(`${init.method} ${path}`);
    const id = path.split("/")[3];
    return (answers[id] ?? (() => Response.json({ invoice: {}, warnings: [] })))();
  });
  const printTicked = new Set(ticks);
  const setPrintTicked = vi.fn((next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    log.push("ticks");
    const value = typeof next === "function" ? next(new Set(printTicked)) : next;
    printTicked.clear();
    for (const id of value) printTicked.add(id);
  });
  const setFinalizing = vi.fn((v: boolean) => { log.push(`finalizing ${v}`); });
  const setFinalizeErrors = vi.fn((e: Map<string, string>) => { log.push(`errors ${[...e.keys()].join(",")}`); });
  const setFinalizeWarnings = vi.fn((w: Map<string, string[]>) => { log.push(`warnings ${[...w.keys()].join(",")}`); });
  const setFinalizeResult = vi.fn((v: string | null) => { log.push(`result ${v}`); });
  const finalizeSelected = callback<() => Promise<void>>(LIST, "InvoicingList", "finalizeSelected", {
    printing: options.printing ?? false, finalizing: options.finalizing ?? false,
    finalizeRows: finalizeRowsOf(ROWS, printTicked), open, tickableRef, loadInvoicesRef,
    askConfirm, trackedFetch, setPrintTicked, setFinalizing, setFinalizeErrors, setFinalizeWarnings, setFinalizeResult,
    finalizeConfirmParts, runSelectedFinalizes, finalizeResultText, pruneToTickable,
  });
  const requests = () => trackedFetch.mock.calls.map(([path, init]) => `${init.method} ${path}`);
  return { log, answers, open, script, printTicked, finalizeSelected, requests, setFinalizeErrors, setFinalizeWarnings, setFinalizing };
}

const finalize = (id: string) => `POST /api/invoices/${id}/finalize`;

describe("Invoicing list: Finalize selected (#1057)", () => {
  it("asks first, naming the ticked drafts on screen alone, and sends nothing when cancelled", async () => {
    const p = page(undefined, { confirmed: false });
    await p.finalizeSelected();
    const q = finalizeConfirmParts(2);
    expect(p.log).toEqual([`confirm ${q.title} ${q.body} [Finalize selected]`]);
    expect(p.requests()).toEqual([]);
  });

  it("finalizes each ticked draft in the table's order, then reads the list, then sets the ticks and the line", async () => {
    const p = page(["d2", "d1", "f1"]);
    await p.finalizeSelected();
    expect(p.requests()).toEqual([finalize("d1"), finalize("d2")]);
    const q = finalizeConfirmParts(2);
    expect(p.log).toEqual([
      `confirm ${q.title} ${q.body} [Finalize selected]`, "finalizing true", "errors ", "warnings ", "result null",
      finalize("d1"), finalize("d2"), "reload", "ticks", "errors ", "warnings ", `result ${finalizeResultText(2, 2)}`, "finalizing false",
    ]);
    // The finalized drafts stay ticked, so Print selected can follow them.
    expect(p.printTicked).toEqual(new Set(["d1", "d2", "f1"]));
  });

  it("shows a refusal beside its row and carries on", async () => {
    const p = page(["d1", "d2"]);
    p.answers.d1 = () => refusedAnswer("Order #1001 has been voided");
    await p.finalizeSelected();
    expect(p.requests()).toEqual([finalize("d1"), finalize("d2")]);
    expect(p.setFinalizeErrors).toHaveBeenLastCalledWith(new Map([["d1", "Order #1001 has been voided"]]));
    expect(p.log).toContain(`result ${finalizeResultText(1, 2)}`);
  });

  it("shows a finalized row's warnings from its answer, after the reload, cleared at the next run's start (#1063)", async () => {
    const p = page(["d1", "d2"]);
    p.answers.d2 = () => Response.json({ invoice: {}, warnings: ["Line 2 needs a price"] });
    await p.finalizeSelected();
    expect(p.setFinalizeWarnings).toHaveBeenNthCalledWith(1, new Map());
    expect(p.setFinalizeWarnings).toHaveBeenLastCalledWith(new Map([["d2", ["Line 2 needs a price"]]]));
    expect(p.log.indexOf("warnings d2")).toBeGreaterThan(p.log.indexOf("reload"));
  });

  it("calls a 5xx a lost answer on its row", async () => {
    const p = page(["d1"]);
    p.answers.d1 = () => Response.json({ error: "x" }, { status: 503 });
    await p.finalizeSelected();
    expect(p.setFinalizeErrors).toHaveBeenLastCalledWith(new Map([["d1", LOST_FINALIZE]]));
  });

  it("drops a tick whose row the reload no longer gives a box", async () => {
    const p = page(["d1", "d2"]);
    p.script.reload = new Set(["d1"]);
    await p.finalizeSelected();
    expect(p.printTicked).toEqual(new Set(["d1"]));
  });

  it("sends nothing while a print or another finalize run is out, or when nothing finalizable is ticked", async () => {
    for (const options of [{ printing: true }, { finalizing: true }]) {
      const p = page(undefined, options);
      await p.finalizeSelected();
      expect(p.log).toEqual([]);
    }
    const none = page(["f1", "dv"]);
    await none.finalizeSelected();
    expect(none.log).toEqual([]);
  });

  it("stops after the request in flight when the page goes, with no reload and no state after", async () => {
    const p = page(["d1", "d2"]);
    p.answers.d1 = () => { p.open.current = false; return Response.json({}); };
    await p.finalizeSelected();
    expect(p.requests()).toEqual([finalize("d1")]);
    expect(p.log).not.toContain("reload");
    expect(p.log.at(-1)).toBe(finalize("d1"));
  });
});
