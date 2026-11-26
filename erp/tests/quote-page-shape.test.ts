import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { quoteTabs } from "@/lib/quote-tabs";
import { jsxTags, jsxTexts, mentions } from "./helpers/jsx-source";

// How the quote page is shaped since PR 3 of the UX redesign (spec §4.4; the owner's rulings of
// 2026-10-31 on #818): a PageHeader whose title keeps the status, Expired and Deleted badges inside
// the h1 (the flows read `/^Quote #\d+.*Expired/` as a heading), its actions the Unsaved badge,
// Discard changes, "Save quote" (the one primary), "Print quotation", Close/Reopen in More actions
// and "Delete quote" as the title-row DangerButton; three RecordTabs over the mounted sections from
// `src/lib/quote-tabs.ts`; the At-a-glance card from the loaded record; every reason dialog and the
// basis-change confirm through the modal; the Documents table headed Type / Created with an
// "Open PDF" link. Read as source, the way order-hub-shape.test.ts reads the hub: vitest has no DOM,
// and the editor's behaviour is its own lifted suites' (quote-load-waterfall, quote-save-read-overlap,
// unreadable-answer, …).

const PAGE = "src/app/quotes/[id]/QuoteDetail.tsx";
const src = readFileSync(fileURLToPath(new URL(`../${PAGE}`, import.meta.url)), "utf8");
const tags = jsxTags(PAGE);
const named = (name: string) => tags.filter((t) => t.name === name);
const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ");

describe("the quote page's shape (PR 3)", () => {
  it("mounts one PageHeader whose title holds the number and the badges", () => {
    expect(named("PageHeader").length).toBe(1);
    const title = squash(named("PageHeader")[0].attr("title"));
    expect(title).toContain("Quote #{detail.quoteNumber}");
    expect(title).toContain("QUOTE_EXPIRED_LABEL");
    expect(title).toContain("Deleted");
    expect(named("h1").length).toBe(0);
  });

  it("holds the actions in the header: Save quote first, Print quotation, More actions, Delete quote", () => {
    const actions = squash(named("PageHeader")[0].attr("actions"));
    expect(actions).toContain("<UnsavedBadge dirty={dirty} />");
    expect(actions).toContain("Discard changes");
    expect(actions).toContain("Save quote");
    expect(actions).toContain("Print quotation");
    expect(actions).toContain("<ActionMenu");
    expect(actions).toContain("<DangerButton");
    const save = named("button").find((t) => t.attr("onClick") === "() => void save()");
    expect(save?.attr("className")).toBe("BUTTON_PRIMARY");
    expect(save?.attr("disabled")).toBe("editGate.disabled || !dirty || saving");
    const print = named("button").find((t) => t.attr("onClick") === "() => void printQuote()");
    expect(print?.attr("className")).toBe("BUTTON_NEUTRAL");
    expect(print?.attr("disabled")).toBe("!printGate.allowed || printing");
    expect(print?.attr("title")).toBe("printGate.title");
    const danger = named("DangerButton");
    expect(danger.length).toBe(1);
    expect(danger[0].attr("disabled")).toBe("deleteGate.disabled");
    expect(jsxTexts(PAGE, "DangerButton")).toEqual(["Delete quote"]);
    const menu = squash(named("ActionMenu")[0].attr("items"));
    expect(menu).toContain('label: "Close quote"');
    expect(menu).toContain("disabled: closeGate.disabled");
    expect(menu).toContain('label: "Reopen quote"');
    expect(menu).toContain("disabled: reopenGate.disabled");
    expect(src).not.toContain("Close…");
    expect(src).not.toContain("Reopen…");
    expect(src).not.toContain("Delete…");
  });

  it("mounts the three tabs over every section, once each, with the card beside them", () => {
    const tabs = named("RecordTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("label")).toBe("QUOTE_TAB_LABEL");
    expect(tabs[0].attr("tabs")).toBe("quoteTabs()");
    const panels = tabs[0].attr("panels") ?? "";
    const keys = quoteTabs().map((t) => t.key);
    for (const key of keys) expect(panels).toMatch(new RegExp(`(^|[{,\\s])${key}:`));
    for (const component of ["HistoryPanel", "QuoteDocumentsList", "BlockerPanel", "DraftRecoveryNotice", "AtAGlance"]) {
      expect(`${component}: ${named(component).length}`).toBe(`${component}: 1`);
    }
    for (const id of ["lines", "header", "documents", "history"]) {
      expect(tags.some((t) => t.attr("id") === id), id).toBe(true);
    }
    expect(squash(named("AtAGlance")[0].attr("rows"))).toContain('label: "Status"');
  });

  it("asks every reason and the basis change through the modal", () => {
    expect(src).not.toMatch(/\bprompt\(/);
    expect(src).not.toMatch(/\bconfirm\(/);
    expect(mentions(PAGE, "askReason")).toBe(4); // the import and three dialogs
    expect(mentions(PAGE, "askConfirm")).toBe(2); // the import and the basis change
    expect(mentions(PAGE, "reasonPromptText")).toBe(0);
  });

  it("carries the renames and the Documents columns", () => {
    expect(jsxTexts(PAGE, "th")).toEqual(expect.arrayContaining(["Type", "Created"]));
    expect(jsxTexts(PAGE, "th")).not.toContain("Document");
    expect(jsxTexts(PAGE, "th")).not.toContain("Printed");
    expect(jsxTexts(PAGE, "a")).toContain("Open PDF");
    expect(jsxTexts(PAGE, "button")).toContain("Add quote line");
    expect(named("Combobox").map((t) => t.attr("placeholder"))).toContain("Add operation");
    expect(src).not.toContain("Add operation: code…");
    expect(src).not.toContain(">Add line<");
  });

  it("registers its two halves as two sections", () => {
    expect(src).toContain("useUnsavedSection(Object.keys(patch).length > 0, QUOTE_DETAILS_SECTION, undefined, { recoverable: true })");
    expect(src).toContain("useUnsavedSection(linesDirty || breakDraftStarted, QUOTE_LINES_SECTION, undefined, { recoverable: true })");
  });
});
