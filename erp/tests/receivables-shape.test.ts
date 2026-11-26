import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsxTags, jsxTexts, mentions } from "./helpers/jsx-source";

// How the five Receivables screens are shaped since PR 7 of the UX redesign (spec §4.3–§4.5; the
// owner's rulings of 2026-11-01 on #822). Read as source: vitest has no DOM, and each page's
// behaviour is its lifted suites' (money-single-boxes, money-panel-messages, unreadable-answer,
// statements-screen, close-screen, read-slot-owners, …).

const read = (page: string) => readFileSync(fileURLToPath(new URL(`../${page}`, import.meta.url)), "utf8");
const named = (page: string, name: string) => jsxTags(page).filter((t) => t.name === name);
const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ");

describe("the batch list's shape (PR 7)", () => {
  const PAGE = "src/app/receivables/ReceivablesList.tsx";
  const src = read(PAGE);

  it("mounts one PageHeader titled Receivables with the New batch action, no h1, and the three presets over the status filter", () => {
    expect(named(PAGE, "PageHeader").length).toBe(1);
    expect(named(PAGE, "PageHeader")[0].attr("title")).toBe("Receivables");
    expect(named(PAGE, "h1").length).toBe(0);
    const tabs = named(PAGE, "ListTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("label")).toBe("RECEIVABLES_VIEWS_LABEL");
    expect(tabs[0].attr("tabs")).toBe("RECEIVABLES_PRESETS");
    expect(squash(tabs[0].attr("active"))).toBe("presetFor({ status })");
    // The Status select is gone: the presets are its three settings.
    expect(named(PAGE, "select").length).toBe(0);
  });

  it("keeps the New batch form inline, its submit reading Create batch, the header button focusing Deposit date", () => {
    const buttons = jsxTexts(PAGE, "button");
    expect(buttons).toContain("New batch");
    expect(src).toContain('{creating ? "Creating…" : "Create batch"}');
    expect(mentions(PAGE, "focusNewBatch")).toBe(2); // the function and the header button's onClick
    expect(src).toContain("depositDateRef");
    expect(jsxTexts(PAGE, "th")).toEqual(["Batch #", "Deposit date", "Status", "Control total", "Entered", "Balance"]);
    expect(mentions(PAGE, "controlTotalText")).toBe(2); // the import and the cell
  });
});

describe("the deposit batch page's shape (PR 7)", () => {
  const PAGE = "src/app/receivables/batches/[id]/BatchDetail.tsx";
  const src = read(PAGE);

  it("mounts one PageHeader titled Batch #N with the leaf's subtitle, Post batch the primary, Reopen in the menu, Void batch the danger action", () => {
    const header = named(PAGE, "PageHeader");
    expect(header.length).toBe(1);
    expect(squash(header[0].attr("title"))).toBe("`Batch #${batch.batchNumber}`");
    expect(header[0].attr("subtitle")).toBe("batchSubtitle(batch)");
    expect(named(PAGE, "h1").length).toBe(0);
    const post = named(PAGE, "button").find((t) => (t.attr("onClick") ?? "").includes("postBatchAction()"));
    expect(post?.attr("disabled")).toBe("!postGate.allowed");
    expect(post?.attr("className")).toBe("BUTTON_PRIMARY");
    expect(jsxTexts(PAGE, "button")).toContain("Post batch");
    const menu = named(PAGE, "ActionMenu");
    expect(menu.length).toBe(1);
    expect(squash(menu[0].attr("items"))).toContain('label: "Reopen batch", disabled: !reopenGate.allowed, title: reopenGate.title, onSelect: () => void reopenBatchAction()');
    const danger = named(PAGE, "DangerButton");
    expect(danger.length).toBe(1);
    expect(danger[0].attr("disabled")).toBe("!voidBatchGate.allowed");
    expect(jsxTexts(PAGE, "DangerButton")).toEqual(["Void batch"]);
  });

  it("mounts the two tabs over the mounted sections with the card beside them", () => {
    const tabs = named(PAGE, "RecordTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("label")).toBe("RECEIPT_BATCH_TAB_LABEL");
    expect(tabs[0].attr("tabs")).toBe("receiptBatchTabs()");
    const panels = tabs[0].attr("panels") ?? "";
    for (const key of ["payments", "history"]) expect(panels).toMatch(new RegExp(`(^|[{,\\s])${key}:`));
    for (const id of ["add-payment", "payments", "history"]) {
      expect(jsxTags(PAGE).some((t) => t.attr("id") === id), id).toBe(true);
    }
    expect(named(PAGE, "HistoryPanel").length).toBe(1);
    const card = squash(named(PAGE, "AtAGlance")[0].attr("rows"));
    for (const label of ['"Deposit date"', '"Status"', '"Control total"', '"Entered"', '"Balance"']) expect(card).toContain(label);
    expect(card).toContain("controlTotalText(batch.controlTotal)");
    expect(card).toContain("balanceText(batch.balance)");
    // The header tile row is gone with its colours; the words carry the meaning (#163).
    expect(src).not.toContain("bg-link-50 text-link-700");
  });

  it("asks every reason and confirm through the modal, Hide through askDiscard", () => {
    expect(src).not.toMatch(/\bprompt\(/);
    expect(src).not.toMatch(/\bconfirm\(/);
    expect(src).not.toMatch(/\bconfirmDiscard\(/);
    expect(mentions(PAGE, "askConfirm")).toBe(2); // the import and Post
    expect(mentions(PAGE, "askReason")).toBe(5); // the import, Void application, Void payment, Reopen, Void batch
    expect(mentions(PAGE, "askDiscard")).toBe(2); // the import and Hide / open another
    expect(mentions(PAGE, "reasonPromptText")).toBe(0);
    expect(src).toContain("await askConfirm(postConfirm(batch.batchNumber))");
    for (const sentence of ["A reason is required to void an application.", "A reason is required to void a payment.",
      "A reason is required to reopen a batch.", "A reason is required to void a batch."]) {
      expect(src).toContain(`blankRefusal: "${sentence}"`);
    }
    expect(src).toContain('await askDiscard({ action: "Close the current payment application and discard its draft?" })');
  });

  it("carries the renames: Void payment on the row, Apply ($) on the apply grid, History a tab", () => {
    expect(jsxTexts(PAGE, "button")).toContain("Void payment");
    const heads = jsxTexts(PAGE, "th");
    expect(heads).toContain("Apply ($)");
    expect(heads.filter((h) => h === "Amount")).toHaveLength(2); // the applications table's and the Payments table's
    expect(src).toContain("Voided — see History for the reason.");
    expect(src).not.toContain("see History below");
  });
});

describe("the A/R aging screen's shape (PR 7)", () => {
  const PAGE = "src/app/receivables/aging/AgingReport.tsx";
  const src = read(PAGE);

  it("mounts one PageHeader per branch with Export to Excel as the header's action, the filter label Customer, and the card", () => {
    // Two branches (denied, and the report), each headed; the h1s are gone.
    const headers = named(PAGE, "PageHeader");
    expect(headers.length).toBe(2);
    expect(headers.every((h) => h.attr("title") === "TITLE")).toBe(true);
    expect(src).toContain('const TITLE = "A/R Aging";');
    expect(named(PAGE, "h1").length).toBe(0);
    const exportLink = named(PAGE, "a").find((t) => (t.attr("href") ?? "").includes("/api/receivables/aging/export"));
    expect(exportLink?.attr("className")).toBe("BUTTON_NEUTRAL");
    expect(jsxTexts(PAGE, "a")).toContain("Export to Excel");
    expect(jsxTexts(PAGE, "label")).toContain("Customer <Combobox>");
    expect(src).not.toContain("Customer / family");
    const card = squash(named(PAGE, "AtAGlance")[0].attr("rows"));
    expect(card).toContain('"Current"');
    expect(card).toContain('"Total A/R"');
    expect(card).toContain("totals.net");
    // The table keeps Unapplied and Net (Total and Past due are #822 items).
    expect(jsxTexts(PAGE, "th")).toEqual(expect.arrayContaining(["Customer", "Unapplied", "Net"]));
  });
});

describe("the statements screen's shape (PR 7)", () => {
  const PAGE = "src/app/receivables/statements/Statements.tsx";
  const src = read(PAGE);

  it("mounts one PageHeader per branch, the print primary keeping its mode swap, the run in the menu", () => {
    const headers = named(PAGE, "PageHeader");
    expect(headers.length).toBe(2);
    expect(headers.every((h) => h.attr("title") === "Statements")).toBe(true);
    expect(named(PAGE, "h1").length).toBe(0);
    expect(headers[1].attr("subtitle")).toBe("Choose the customer and date before printing.");
    const print = named(PAGE, "button").find((t) => (t.attr("onClick") ?? "").includes("printPerDivision()"));
    expect(print?.attr("disabled")).toBe("printTitle !== undefined");
    expect(print?.attr("className")).toBe("BUTTON_PRIMARY");
    expect(src).toContain('{printing ? "Printing…" : perDivisionMode ? "Print per division" : "Print statement"}');
    const menu = named(PAGE, "ActionMenu");
    expect(menu.length).toBe(1);
    expect(squash(menu[0].attr("items"))).toContain('label: running ? "Running…" : "Run for everyone with a balance", disabled: runTitle !== undefined, title: runTitle, onSelect: () => void runForEveryone()');
    expect(src).not.toContain("Ignores the customer chosen above");
  });

  it("asks both confirms through the modal and carries the renames", () => {
    expect(src).not.toMatch(/\bconfirm\(/);
    expect(mentions(PAGE, "askConfirm")).toBe(3); // the import, per division, the run
    expect(src).toContain("await askConfirm(perDivisionConfirm(members.length, asOf, names))");
    expect(src).toContain("await askConfirm(runConfirm(asOf))");
    const heads = jsxTexts(PAGE, "h2");
    expect(heads).toContain("Saved statements");
    expect(heads).not.toContain("Documents");
    expect(src).toContain("is in Saved statements.");
    expect(src).toContain("Finance charge (not billed, not included in total):");
    expect(src).not.toContain("not in total)");
  });
});

describe("the month-end close screen's shape (PR 7)", () => {
  const PAGE = "src/app/receivables/close/Close.tsx";
  const src = read(PAGE);

  it("mounts one PageHeader per branch with Close period as the header's primary, two tabs and the card", () => {
    const headers = named(PAGE, "PageHeader");
    expect(headers.length).toBe(2);
    expect(headers.every((h) => h.attr("title") === "TITLE")).toBe(true);
    expect(src).toContain('const TITLE = "Month-End Close";');
    expect(squash(headers[1].attr("subtitle"))).toBe("closeSubtitle(period && periodLabel(period.year, period.month))");
    expect(named(PAGE, "h1").length).toBe(0);
    const close = named(PAGE, "button").find((t) => (t.attr("onClick") ?? "").includes("doClose()"));
    expect(close?.attr("disabled")).toBe("closeTitle !== undefined");
    expect(close?.attr("title")).toBe("closeTitle");
    expect(close?.attr("className")).toBe("BUTTON_PRIMARY");
    const tabs = named(PAGE, "RecordTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("label")).toBe("CLOSE_TAB_LABEL");
    expect(tabs[0].attr("tabs")).toBe("closeTabs()");
    const panels = tabs[0].attr("panels") ?? "";
    for (const key of ["reconcile", "closed"]) expect(panels).toMatch(new RegExp(`(^|[{,\\s])${key}:`));
    for (const id of ["period", "continuity", "readiness", "closed-periods"]) {
      expect(jsxTags(PAGE).some((t) => t.attr("id") === id), id).toBe(true);
    }
    const card = squash(named(PAGE, "AtAGlance")[0].attr("rows"));
    for (const label of ['"Continuity A/R"', '"Aging A/R"', '"Variance"']) expect(card).toContain(label);
    expect(card).toContain("schedule.endingAr");
    expect(card).toContain("schedule.agingEndingAr");
    expect(card).toContain("schedule.variance");
    // The Close refusal is the card's, beside the header's button, so a refused close is seen from
    // either tab (Codex on #848); the Period section keeps its two notices.
    expect(named(PAGE, "PanelMessage").map((t) => t.attr("message")).sort()).toEqual([
      "closeRefusal", "rowMessage !== null && rowMessage.id === p.id ? rowMessage.text : null",
    ]);
    const cardBlock = src.slice(src.indexOf("<AtAGlance"), src.indexOf("</AtAGlance>"));
    expect(cardBlock).toContain("<PanelMessage message={closeRefusal} />");
    const periodBlock = src.slice(src.indexOf('<section id="period"'), src.indexOf('<section id="continuity"'));
    expect(periodBlock).not.toContain("closeRefusal");
  });

  it("asks Reopen through the modal and carries the renames", () => {
    expect(src).not.toMatch(/\bprompt\(/);
    expect(mentions(PAGE, "askReason")).toBe(2); // the import and Reopen
    expect(mentions(PAGE, "reasonPromptText")).toBe(0);
    expect(src).toContain('blankRefusal: "A reason is required to reopen a period"');
    const cells = jsxTexts(PAGE, "td");
    expect(cells).toEqual(expect.arrayContaining(["− Posted payments", "Ending A/R", "Aging ending A/R"]));
    expect(cells).not.toContain("− Payments");
    expect(cells).not.toContain("= Ending A/R");
    expect(src).not.toContain("(independent check)");
    expect(src).toContain('{exportingId === p.id ? "Exporting…" : "Export GL summary"}');
    expect(src).not.toContain('"Export to GL"');
    expect(src).toContain("{`Reopen ${periodLabel(p.year, p.month)}`}");
  });
});
