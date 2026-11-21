// Ruling 5 of 2026-10-30: the sites the page PRs left behind ask through the one modal
// (src/lib/modal.ts), and `confirmDiscard` is left to the Shell alone. Read as text, because vitest
// renders none of these pages; `removeLine` and its answers are lifted and run in
// tests/lines-section-wiring.test.ts, and the reason dialog's shape is
// tests/reason-prompt.test.ts's census.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { callback } from "./helpers/lift-callback";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../src/app/${path}`, import.meta.url)), "utf8");

/** Every call of a bare `name(...)`, however it is reached: the words of a comment are not one. */
function calls(source: string, name: string): string[] {
  const sf = ts.createSourceFile("site.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      const bare = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
      if (bare === name) found.push(node.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("the four leftover dialogs ask through the modal (ruling 5)", () => {
  const SITES = {
    receivables: read("customers/[id]/ReceivablesSection.tsx"),
    overrides: read("customers/[id]/SurchargeOverridesSection.tsx"),
    lines: read("orders/[id]/LinesSection.tsx"),
    board: read("page.tsx"),
  };

  it("leaves no native confirm or prompt at any of them", () => {
    for (const [site, source] of Object.entries(SITES)) {
      expect(`${site}: ${calls(source, "confirm").concat(calls(source, "prompt")).join()}`).toBe(`${site}: `);
    }
  });

  it("states the write-off's question, verb and blank sentence once in the ask", () => {
    const [ask] = calls(SITES.receivables, "askReason");
    expect(ask).toContain("`Void the write-off of ${formatMoney(w.amount)} against ${item.documentNumber}?\\n\\n`");
    expect(ask).toContain('verb: "voiding", blankRefusal: "A reason is required to void a write-off."');
  });

  it("splits Clear override as the surcharges page's does, the plant-rate clause as the body", () => {
    expect(calls(SITES.overrides, "askConfirm")).toEqual([expect.stringContaining('title: `Clear the "${surchargeName}" override?`')]);
    const [ask] = calls(SITES.overrides, "askConfirm");
    expect(ask).toContain("body: `This customer will bill at the ${plantDefaultNoun(kind)} instead.`");
    expect(ask).toContain('confirm: "Clear override", danger: true');
  });

  it("keeps the saved view's sentence as the title, and its name on the button", () => {
    expect(calls(SITES.board, "askConfirm")).toEqual([
      'askConfirm({ title: `Delete saved view "${view.name}"?`, body: "", confirm: "Delete saved view", danger: true })',
    ]);
  });
});

describe("survey 11's three dialogs ask through the modal (ruling 5; #827)", () => {
  const readSrc = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");
  const SITES = {
    roles: read("admin/roles/page.tsx"),
    practice: read("practice/PracticeResetControl.tsx"),
    signature: readSrc("components/UserSignatureControl.tsx"),
  };

  it("leaves no native confirm or prompt at any of them", () => {
    for (const [site, source] of Object.entries(SITES)) {
      expect(`${site}: ${calls(source, "confirm").concat(calls(source, "prompt")).join()}`).toBe(`${site}: `);
    }
  });

  it("deletes a role through the reason leaf, in the service's blank sentence", () => {
    const [ask] = calls(SITES.roles, "askReason");
    expect(ask).toContain('question: `Delete role "${role.name}"?`');
    expect(ask).toContain('verb: "deleting", blankRefusal: ROLE_DELETE_REASON_REQUIRED');
  });

  it("states the practice reset in the owner's words, red", () => {
    const [ask] = calls(SITES.practice, "askConfirm");
    expect(ask).toContain('title: "Reset all practice data?"');
    expect(ask).toContain("Everything entered in this practice copy will be permanently replaced with the sample baseline. ");
    expect(ask).toContain("Practice installation only. This signs you out because the practice sessions and users are reset.");
    expect(ask).toContain('confirm: "Reset practice data", danger: true');
  });

  it("clears a signature on a red Clear", () => {
    expect(calls(SITES.signature, "askConfirm")).toEqual([expect.stringContaining('title: "Clear this signature?", body: "", confirm: "Clear", danger: true')]);
  });
});

describe("the hub's two discard questions ask through the modal (ruling 5)", () => {
  const INVOICES = read("orders/[id]/InvoicesSection.tsx");
  const LOADS = read("orders/[id]/LoadsSection.tsx");

  it("leaves no native confirm, prompt or confirmDiscard at either", () => {
    for (const source of [INVOICES, LOADS]) {
      expect(["confirm", "prompt", "confirmDiscard"].flatMap((name) => calls(source, name))).toEqual([]);
    }
  });

  it("keeps each question's words: Create invoice's the leave wording, Re-split's its own", () => {
    expect(calls(INVOICES, "askDiscard")).toEqual(["askDiscard()"]);
    const [ask] = calls(LOADS, "askDiscard");
    expect(ask).toContain("Re-split loads using the part’s current defaults? This replaces the current load rows and their unsaved edits.");
  });

  function askResplit(answer: boolean, mounted = true) {
    const resplit = vi.fn(async () => {});
    const ref = { current: mounted };
    const run = callback<() => Promise<void>>("app/orders/[id]/LoadsSection.tsx", "LoadsSection", "askResplit", {
      askDiscard: async () => answer, resplit, mounted: ref,
    });
    return { run, resplit, ref };
  }

  it("Re-split runs on a yes, and only then", async () => {
    const yes = askResplit(true); await yes.run();
    expect(yes.resplit).toHaveBeenCalledOnce();
    const no = askResplit(false); await no.run();
    expect(no.resplit).not.toHaveBeenCalled();
  });

  it("a section gone under the question sends nothing on a yes", async () => {
    const h = askResplit(true); const pending = h.run();
    h.ref.current = false; await pending;
    expect(h.resplit).not.toHaveBeenCalled();
  });
});

describe("confirmDiscard is the Shell's alone (ruling 5)", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const sources = (readdirSync(SRC, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file) && !/\.d\.ts$/.test(file));

  it("is called from no file under src/ but the Shell: the browser's own dialog is its navigation guard's", () => {
    expect(sources.length).toBeGreaterThan(100);
    const callers = sources.filter((file) => calls(readFileSync(`${SRC}/${file}`, "utf8"), "confirmDiscard").length > 0);
    expect(callers).toEqual(["components/Shell.tsx"]);
  });
});
