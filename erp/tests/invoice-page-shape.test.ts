import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { invoiceTabs } from "@/lib/invoice-tabs";
import { jsxTags, jsxTexts, mentions } from "./helpers/jsx-source";

// How the invoice page is shaped since PR 6 of the UX redesign (spec §4.4; the owner's rulings of
// 2026-10-31 on #821): a PageHeader titled by `invoiceTitle` (the status, customer and order in
// one subtitle string, so the card's Status row is the page's one node reading exactly "Draft" or
// "Finalized"), Finalize the primary and Print beside it, Recalculate lines, Create credit and
// Unlock in More actions, Discard the title-row DangerButton (ruling 8); three RecordTabs over the
// mounted sections from `src/lib/invoice-tabs.ts`; the At a glance card from the loaded record
// with the seven totals, holding the totals message and the print messages; Unlock and Discard
// asking through the modal, Create credit through askDiscard; the finalized sentence and the
// Documents column as ruled. Read as source: vitest has no DOM, and the page's behaviour is its
// lifted suites' (invoice-detail-pending, unreadable-answer, navigation-callers, print-tab, …).

const PAGE = "src/app/invoicing/[id]/InvoiceDetail.tsx";
const src = readFileSync(fileURLToPath(new URL(`../${PAGE}`, import.meta.url)), "utf8");
const tags = jsxTags(PAGE);
const named = (name: string) => tags.filter((t) => t.name === name);
const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ");

describe("the invoice page's shape (PR 6)", () => {
  it("mounts one PageHeader titled by the leaf, the status composed into one subtitle string", () => {
    expect(named("PageHeader").length).toBe(1);
    expect(named("PageHeader")[0].attr("title")).toBe("invoiceTitle(invoice)");
    expect(named("PageHeader")[0].attr("subtitle")).toBe("subtitle");
    expect(named("h1").length).toBe(0);
    const subtitle = src.slice(src.indexOf("const subtitle = ["), src.indexOf('].join(" · ");'));
    expect(subtitle).toContain("INVOICE_STATUS_LABELS[invoice.status],");
  });

  it("puts Finalize and Print in the header, the three others in the menu and Discard in the title row, each on its gate", () => {
    const finalize = named("button").find((t) => (t.attr("onClick") ?? "").includes("finalize()"));
    expect(finalize?.attr("disabled")).toBe("!finalizeGate.allowed || busy !== null");
    expect(finalize?.attr("className")).toBe("BUTTON_PRIMARY");
    const print = named("button").find((t) => (t.attr("onClick") ?? "").includes("printInvoice()"));
    expect(print?.attr("disabled")).toBe("!printGate.allowed || printing");
    expect(print?.attr("className")).toBe("BUTTON_NEUTRAL");
    expect(src).toContain('{busy === "finalize" ? "Finalizing…" : labels.finalize}');
    expect(src).toContain('{printing ? "Printing…" : labels.print}');
    const menu = named("ActionMenu");
    expect(menu.length).toBe(1);
    const items = squash(menu[0].attr("items"));
    expect(items).toContain('label: busy === "recalc" ? "Recalculating…" : labels.recalculate, disabled: !recalcGate.allowed || busy !== null, title: recalcGate.title, onSelect: () => void recalculate()');
    expect(items).toContain('label: busy === "credit" ? "Creating…" : labels.credit, disabled: !creditGate.allowed || busy !== null, title: creditGate.title, onSelect: () => void raiseCredit()');
    expect(items).toContain("label: labels.unlock, disabled: !unlockGate.allowed, title: unlockGate.title, onSelect: () => void unlock()");
    const danger = named("DangerButton");
    expect(danger.length).toBe(1);
    expect(danger[0].attr("disabled")).toBe("!discardGate.allowed");
    expect(src).toContain("{labels.discard}");
    expect(src).not.toContain('"Raise credit"');
    expect(src).not.toContain('"Raising…"');
  });

  it("mounts the three tabs over every section, once each, with the card beside them", () => {
    const tabs = named("RecordTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("label")).toBe("INVOICE_TAB_LABEL");
    expect(tabs[0].attr("tabs")).toBe("invoiceTabs()");
    const panels = tabs[0].attr("panels") ?? "";
    for (const key of invoiceTabs().map((t) => t.key)) expect(panels).toMatch(new RegExp(`(^|[{,\\s])${key}:`));
    for (const component of ["HistoryPanel", "InvoiceDocumentsList", "InvoiceLinesGrid", "AtAGlance"]) {
      expect(`${component}: ${named(component).length}`).toBe(`${component}: 1`);
    }
    // Two PanelMessages in the file: the grid's own (`saveMessage`) and the card's (`totalsMessage`).
    expect(named("PanelMessage").map((t) => t.attr("message")).sort()).toEqual(["saveMessage", "totalsMessage"]);
    for (const id of ["header", "lines", "documents", "history"]) {
      expect(tags.some((t) => t.attr("id") === id), id).toBe(true);
    }
    // The totals section is gone: the seven figures and the totals message are the card's.
    const card = squash(named("AtAGlance")[0].attr("rows"));
    for (const label of ['"Customer"', '"Order"', '"Status"', '"Printed"', '"Operations"', '"Surcharges"', '"Charges"', '"Certification"', '"Freight"', '"Tax"', '"Invoice total"']) {
      expect(card).toContain(label);
    }
    expect(src).not.toContain("Subtotal (operations)");
    expect(src).not.toContain('<span className="border-t pt-1 font-medium">Total</span>');
    // The documents read is the page's, lifted, so the card's Printed is the newest print's; a landed
    // read with no prints ("empty") reads Not printed, and only an unlanded one "—" (the review's item 2).
    expect(mentions(PAGE, "useStoredDocuments")).toBe(3); // the import, the page's one read, the list's prop type
    expect(mentions(PAGE, "printedSince")).toBe(2); // the import and the card
    expect(card).toContain('documents.status === "rows" || documents.status === "empty"');
  });

  it("asks Unlock and Discard through the modal and Create credit through askDiscard", () => {
    expect(src).not.toMatch(/\bprompt\(/);
    expect(src).not.toMatch(/\bconfirm\(/);
    expect(src).not.toMatch(/\bconfirmDiscard\(/);
    expect(mentions(PAGE, "askReason")).toBe(3); // the import, Unlock and Discard
    expect(mentions(PAGE, "askDiscard")).toBe(2); // the import and Create credit
    expect(mentions(PAGE, "reasonPromptText")).toBe(0);
    expect(src).toContain("A reason is required to unlock an invoice.");
    expect(src).toContain("A reason is required to discard an invoice.");
    expect(src).toContain("if (!(await askDiscard())) { attempt.cancel(); return; }");
  });

  it("carries the renames: the finalized sentence, the Documents column, the blocked-window sentence", () => {
    expect(src).toContain("Finalized — these are the figures this invoice was issued on.");
    expect(src).not.toContain("are no longer editable");
    const heads = jsxTexts(PAGE, "th");
    expect(heads).toEqual(expect.arrayContaining(["Document", "Created"]));
    expect(heads).not.toContain("Printed");
    expect(src).toContain("is in Documents & history.");
    expect(src).not.toContain("is in Documents below");
  });
});
