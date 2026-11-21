import { describe, expect, it } from "vitest";
import { INVOICING_PRESETS, applyPreset, presetFor, type InvoicingPresetKey } from "@/lib/invoicing-list";
import { confirmParts, confirmText } from "@/lib/print-selected";

// The Invoicing list's four views (spec 2026-10-30-ux-redesign-design.md §4.5; the UX redesign
// PR 6, owner 2026-10-31 on #821): Ready to invoice is the candidates table alone, a view and never
// a filter; Drafts, To print and Register are settings of the register's Status and Printed selects,
// derived back from them (`presetFor`), so a hand-picked Status = Finalized with Printed blank
// lights nothing. Customer and the dates narrow within a preset.

const filters = { view: "invoices" as const, customerId: "c1", status: "" as const, printed: "" as const, from: "2026-10-01", to: "" };

describe("INVOICING_PRESETS", () => {
  it("names the four views in the file's order", () => {
    expect(INVOICING_PRESETS.map((p) => [p.key, p.label])).toEqual([
      ["ready", "Ready to invoice"], ["drafts", "Drafts"], ["toPrint", "To print"], ["register", "Register"],
    ]);
  });
});

describe("applyPreset", () => {
  it("Ready switches the view and leaves the register's filters as they stand", () => {
    const set = { ...filters, status: "DRAFT" as const, printed: "1" as const };
    expect(applyPreset(set, "ready")).toEqual({ ...set, view: "ready" });
  });
  it("Drafts, To print and Register set the view and the two selects, every other field kept", () => {
    expect(applyPreset(filters, "drafts")).toEqual({ ...filters, view: "invoices", status: "DRAFT", printed: "" });
    expect(applyPreset(filters, "toPrint")).toEqual({ ...filters, view: "invoices", status: "FINALIZED", printed: "0" });
    expect(applyPreset({ ...filters, status: "DRAFT", printed: "1" }, "register")).toEqual({ ...filters, view: "invoices", status: "", printed: "" });
  });
  it("round-trips: each preset applied reads back as itself", () => {
    for (const key of INVOICING_PRESETS.map((p) => p.key as InvoicingPresetKey)) {
      expect(presetFor(applyPreset(filters, key)), key).toBe(key);
    }
  });
});

describe("presetFor (review focus 1)", () => {
  it("is Ready while the view is the candidates, whatever the selects hold", () => {
    expect(presetFor({ view: "ready", status: "FINALIZED", printed: "1" })).toBe("ready");
  });
  it("reads the two selects on the register view", () => {
    expect(presetFor({ view: "invoices", status: "DRAFT", printed: "" })).toBe("drafts");
    expect(presetFor({ view: "invoices", status: "FINALIZED", printed: "0" })).toBe("toPrint");
    expect(presetFor({ view: "invoices", status: "", printed: "" })).toBe("register");
  });
  it("lights nothing for a pair no preset sets", () => {
    expect(presetFor({ view: "invoices", status: "FINALIZED", printed: "" })).toBeNull();
    expect(presetFor({ view: "invoices", status: "", printed: "1" })).toBeNull();
    expect(presetFor({ view: "invoices", status: "DRAFT", printed: "0" })).toBeNull();
  });
});

describe("confirmParts: the Print selected modal's title and body (review focus 5)", () => {
  it("splits the ruled sentence after its question, one and many", () => {
    expect(confirmParts(1)).toEqual({
      title: "Print 1 document?", body: "It is filed under its own Documents, and the PDF downloads as a zip file.",
    });
    expect(confirmParts(12)).toEqual({
      title: "Print 12 documents?", body: "Each is filed under its own Documents, and the PDFs download as one zip file.",
    });
  });
  it("is the one sentence, so the two cannot drift", () => {
    for (const n of [1, 2, 12]) {
      const { title, body } = confirmParts(n);
      expect(`${title} ${body}`).toBe(confirmText(n));
    }
  });
});
