import ts from "typescript";
import { quoteDraftFrom, quoteRecoveryAdapter, removeQuoteLine, removeQuotePrice, type QuoteBaseline } from "../src/lib/quote-recovery";
import { openDraftHarness } from "./helpers/draft-store";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  breakDraftStarted, dropBreakDrafts, patchBreakDraft, priceKeysOf, retainBreakDrafts,
  EMPTY_BREAK_DRAFT, type BreakDrafts,
} from "@/lib/break-drafts";

// The un-added quantity-break drafts behind QuoteDetail, extracted so they can be tested at all:
// the vitest environment is "node" with no DOM, so the component itself is out of reach — the
// field-drafts.ts precedent. (The old per-step process editor's own `dropDrafts`, the shape this
// clones, stayed inline and so never had a unit test.)
//
// The defect these exist for is #278: a started break draft whose price row was then removed kept
// `breakDraftStarted` true forever, arming the navigation guard from a page with no control able
// to clear it — the Add-break inputs that could blank it were unmounted with the row. Every
// assertion below is written so that deleting the prune it names turns it RED; the composed
// "the defect itself" cases at the bottom of each describe are the ones that do that most directly.

const started = { threshold: "100", price: "9.50" };
const blank = { threshold: "", price: "" };
const drafts = (o: Record<string, { threshold: string; price: string }>): BreakDrafts => o;

describe("breakDraftStarted", () => {
  it("is armed by a draft holding either field", () => {
    expect(breakDraftStarted(drafts({ p1: started }))).toBe(true);
    expect(breakDraftStarted(drafts({ p1: { threshold: "100", price: "" } }))).toBe(true);
    expect(breakDraftStarted(drafts({ p1: { threshold: "", price: "9.50" } }))).toBe(true);
  });

  it("is empty-content, NOT key-count — a cleared input leaves a blank entry behind", () => {
    // Mutation-proof: rewritten as `Object.keys(drafts).length > 0` this reds, and the page would
    // report unsaved changes for every price row whose Add-break inputs had ever been touched.
    expect(breakDraftStarted(drafts({ p1: blank, p2: blank }))).toBe(false);
    expect(breakDraftStarted(drafts({}))).toBe(false);
  });

  it("treats a whitespace-only draft as unstarted", () => {
    expect(breakDraftStarted(drafts({ p1: { threshold: "   ", price: "\t" } }))).toBe(false);
  });
});

describe("dropBreakDrafts", () => {
  it("removes exactly the named keys and leaves every sibling untouched", () => {
    const cur = drafts({ p1: started, p2: { threshold: "5", price: "1" }, p3: blank });
    const next = dropBreakDrafts(cur, ["p1", "p3"]);
    expect(Object.keys(next).sort()).toEqual(["p2"]);
    expect(next.p2).toEqual({ threshold: "5", price: "1" });
  });

  it("drops a whole line's worth of keys in one call", () => {
    const cur = drafts({ a1: started, a2: started, b1: started });
    expect(Object.keys(dropBreakDrafts(cur, ["a1", "a2"]))).toEqual(["b1"]);
  });

  it("hands back the SAME object when no named key is present, so React bails out", () => {
    // Mutation-proof: delete the `!priceKeys.some(...)` bailout and this reds — every removal of an
    // unrelated row would mint a new record and re-render.
    const cur = drafts({ p1: started });
    expect(dropBreakDrafts(cur, ["gone"])).toBe(cur);
    expect(dropBreakDrafts(cur, [])).toBe(cur);
  });

  it('"all" empties the record, and is a no-op on an already-empty one', () => {
    const cur = drafts({ p1: started, p2: blank });
    expect(dropBreakDrafts(cur, "all")).toEqual({});
    const empty = drafts({});
    expect(dropBreakDrafts(empty, "all")).toBe(empty);
  });

  it("never mutates the record it was handed", () => {
    const cur = drafts({ p1: started, p2: started });
    dropBreakDrafts(cur, ["p1"]);
    dropBreakDrafts(cur, "all");
    expect(Object.keys(cur).sort()).toEqual(["p1", "p2"]);
  });

  it("THE DEFECT: a started draft stops arming the guard once its price row is dropped", () => {
    // #278 in one line. Mutation-proof: remove the `setBreakDrafts(... dropBreakDrafts ...)` call
    // from removePrice/removeLine and the page is left exactly as this asserts it must not be —
    // started, with no live row and no input able to blank it.
    const cur = drafts({ p1: started });
    expect(breakDraftStarted(cur)).toBe(true);
    expect(breakDraftStarted(dropBreakDrafts(cur, ["p1"]))).toBe(false);
  });
});

describe("retainBreakDrafts", () => {
  it("drops a draft whose price key did not survive the new tree", () => {
    const cur = drafts({ "new-3": started, p1: started });
    expect(Object.keys(retainBreakDrafts(cur, ["p1"]))).toEqual(["p1"]);
  });

  it("KEEPS a draft whose price key is still live — an intersection, never a reset", () => {
    // Mutation-proof and the load-bearing direction: rewritten as a wholesale clear this reds, and
    // close/reopen/attach-part — all reachable with a draft typed, since `dirty` excludes break
    // drafts — would silently destroy typed work that exists in no payload and no other state.
    const cur = drafts({ p1: started, p2: started });
    const next = retainBreakDrafts(cur, ["p1", "p2", "p3"]);
    expect(next).toBe(cur);
    expect(next.p1).toEqual(started);
  });

  it("hands back the SAME object when every draft is live", () => {
    const cur = drafts({ p1: started });
    expect(retainBreakDrafts(cur, ["p1"])).toBe(cur);
    expect(retainBreakDrafts(drafts({}), [])).toEqual({});
  });

  it("accepts a Set as well as an array of live keys", () => {
    const cur = drafts({ p1: started, gone: started });
    expect(Object.keys(retainBreakDrafts(cur, new Set(["p1"])))).toEqual(["p1"]);
  });

  it("never mutates the record it was handed", () => {
    const cur = drafts({ p1: started, gone: started });
    retainBreakDrafts(cur, ["p1"]);
    expect(Object.keys(cur).sort()).toEqual(["gone", "p1"]);
  });

  it("THE DEFECT, save-adopt shape: a client-added row's draft stops arming the guard once the server re-keys it", () => {
    // A break typed on a price row added client-side sits under a minted `new-N` key; the save's
    // adopt re-keys every price to its server id, so nothing on screen can ever reach that draft
    // again. Same for a row the server re-mints because its step code changed. Neither passes
    // through removePrice or removeLine, which is why the removal-site drops alone do not close
    // #278 — mutation-proof: delete the retain call in `adopt` and this reds.
    const cur = drafts({ "new-3": started });
    expect(breakDraftStarted(cur)).toBe(true);
    expect(breakDraftStarted(retainBreakDrafts(cur, ["p9"]))).toBe(false);
  });
});

describe("priceKeysOf", () => {
  it("flattens every price key across every line", () => {
    expect(priceKeysOf([
      { prices: [{ key: "a1" }, { key: "a2" }] },
      { prices: [] },
      { prices: [{ key: "b1" }] },
    ])).toEqual(["a1", "a2", "b1"]);
  });

  it("is empty for an empty tree", () => {
    expect(priceKeysOf([])).toEqual([]);
  });
});

describe("patchBreakDraft", () => {
  it("seeds a blank draft for a key it has not seen", () => {
    expect(patchBreakDraft(drafts({}), "p1", "threshold", "100"))
      .toEqual({ p1: { threshold: "100", price: "" } });
  });

  it("merges onto the record it was PASSED, not a copy read elsewhere", () => {
    // Mutation-proof for the latent bug this replaced: the inline onChange merged onto the draft
    // read from the render closure, so two writes batched into one tick dropped a field. Chaining
    // both fields through the same record is what that shape cannot survive — ignore `cur` and
    // seed blank instead, and the threshold is lost here.
    const once = patchBreakDraft(drafts({}), "p1", "threshold", "100");
    const twice = patchBreakDraft(once, "p1", "price", "9.50");
    expect(twice.p1).toEqual({ threshold: "100", price: "9.50" });
  });

  it("leaves other rows' drafts alone and never mutates the record it was handed", () => {
    const cur = drafts({ p1: started, p2: blank });
    const next = patchBreakDraft(cur, "p2", "threshold", "7");
    expect(next.p1).toEqual(started);
    expect(cur.p2).toEqual(blank);
  });

  it("EMPTY_BREAK_DRAFT is the same blank the component's lookup falls back to", () => {
    expect(EMPTY_BREAK_DRAFT).toEqual({ threshold: "", price: "" });
    expect(breakDraftStarted(drafts({ p1: EMPTY_BREAK_DRAFT }))).toBe(false);
  });
});

// Execute the actual event callbacks, preserving the original wiring guarantees
// after the form moved its single authority into the recoverable binding.
describe("QuoteDetail break-draft prune sites", () => {
  const src = readFileSync(join(process.cwd(), "src/app/quotes/[id]/QuoteDetail.tsx"), "utf8");
  const source = ts.createSourceFile("QuoteDetail.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function fn(name: string): ts.FunctionDeclaration {
    let found: ts.FunctionDeclaration | undefined;
    function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); }
    visit(source); if (!found) throw new Error(`Missing actual callback ${name}`); return found;
  }
  function callback<T>(name: string, env: Record<string, unknown>): T {
    const code = ts.transpileModule(`return (${fn(name).getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    return new Function(...Object.keys(env), code)(...Object.values(env)) as T;
  }
  function open() {
    const price = (key: string) => ({ id: key, key, processStepCodeId: "step", stepCode: "HT", stepName: "", setupCharge: "", unitPrice: "1", minimumCharge: "", pricePer: "EACH" as const, notes: "", breaks: [] });
    const line = (key: string, priceKeys: string[]) => ({ id: key, key, partId: null, partNumberText: "RAW", partNameText: "", partDescriptionText: "", materialId: null, materialText: "", eachWeight: "", quotedQty: "", quotedUnlimited: false, linkedOrders: [], prices: priceKeys.map(price) });
    const baseline: QuoteBaseline = { id: "quote", customerId: "customer", status: "OPEN", deletedAt: null,
      header: { contactId: "", quoteDate: "2026-09-12", effectiveDate: "2026-09-12", expiryDate: "2026-10-12", followUpDate: "", rfqNumber: "", quotedById: "user", endingStatementId: "", notes: "", internalNotes: "" },
      lines: [line("line-1", ["p1", "p2"]), line("line-2", ["p3"])],
      positions: [{ id: "line-1", position: 1, linkedOrderCount: 0, prices: [{ id: "p1", position: 1 }, { id: "p2", position: 2 }] }, { id: "line-2", position: 2, linkedOrderCount: 0, prices: [{ id: "p3", position: 1 }] }],
      catalogs: { permissions: ["quotes.edit"], contacts: [], users: [], statements: [], steps: [], parts: [], materials: [] },
    };
    const h = openDraftHarness(quoteRecoveryAdapter, quoteDraftFrom(baseline), baseline);
    h.binding.change(d => ({ ...d, breakDrafts: { p1: { threshold: "", price: "bad" }, p2: { threshold: "2", price: "3" }, p3: { threshold: "4", price: "5" } } }));
    return h;
  }
  it("removePrice drops the removed row's own draft", () => {
    const { binding } = open(); callback<(l: string, p: string) => void>("removePrice", { binding, removeQuotePrice })("line-1", "p1");
    expect(binding.getSnapshot().current?.data.breakDrafts).toEqual({ p2: { threshold: "2", price: "3" }, p3: { threshold: "4", price: "5" } });
    expect(binding.getSnapshot().current?.data.lines[0].prices.map(p => p.key)).toEqual(["p2"]);
  });
  it("removeLine drops every price key on the line, not a single key", () => {
    const { binding } = open(); callback<(l: string) => void>("removeLine", { binding, removeQuoteLine })("line-1");
    expect(binding.getSnapshot().current?.data.breakDrafts).toEqual({ p3: { threshold: "4", price: "5" } });
    expect(binding.getSnapshot().current?.data.lines.map(l => l.key)).toEqual(["line-2"]);
  });
  it("discardChanges clears them all — the control that must be able to clear the guard", () => {
    const { binding, store } = open(); callback<() => void>("discardChanges", { binding, setError: vi.fn() })();
    expect(binding.getSnapshot().current?.data.breakDrafts).toEqual({}); expect(store.getSnapshot().count).toBe(0);
  });
  it("native adoption is wired to the tested intersection path for close/reopen/attach", () => {
    // Actual callback execution and literal surviving-row assertions live in
    // quote-recovery.test.ts; these pins prevent disconnecting that tested path.
    for (const action of ["closeQuote", "reopenQuote", "attachPart"]) expect(fn(action).getText(source)).toMatch(/await nativeAction\(/);
    expect(fn("nativeAction").getText(source)).toMatch(/await runQuoteNative\(/);
    expect(fn("save").getText(source)).toMatch(/await runQuoteSave\(/);
  });
  it("the Discard control is enabled by a started draft, and the Save badge is not", () => {
    let disabled: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === "button") {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        if (attributes.some(a => a.name.getText(source) === "onClick" && a.initializer?.getText(source) === "{discardChanges}")) {
          const attribute = attributes.find(a => a.name.getText(source) === "disabled");
          if (attribute?.initializer && ts.isJsxExpression(attribute.initializer)) disabled = attribute.initializer.expression;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source); expect(disabled).toBeDefined();
    const expression = ts.transpileModule(`return (${disabled!.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const dirty of [false, true]) for (const breakDraftStarted of [false, true])
      for (const recoveryBlocked of [false, true]) for (const rawDraftRetained of [false, true]) {
        const env = { dirty, breakDraftStarted, recoveryBlocked, rawDraftRetained };
        expect(new Function(...Object.keys(env), expression)(...Object.values(env))).toBe(
          !(dirty || breakDraftStarted || recoveryBlocked || rawDraftRetained));
      }
    // The badge gates on the editor's own dirty flag alone, never on breakDraftStarted (#640 moved
    // it into the shared UnsavedBadge).
    expect(src).toMatch(/<UnsavedBadge dirty=\{dirty\} \/>/);
  });
});
