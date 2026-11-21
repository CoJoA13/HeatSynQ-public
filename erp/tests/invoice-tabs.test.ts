// The invoice page's tabs, title and action labels (spec 2026-10-30-ux-redesign-design.md §4.4;
// PR 6, owner 2026-10-31 on #821): three tabs over the mounted sections (Header / Lines /
// Documents & history, today's section names by the owner's choice), the lines grid's registry
// label badging Lines alone (review focus 3); a credit titled by its source invoice; the six
// action labels naming the document's kind.
import { describe, expect, it } from "vitest";
import { tabForLocation, tabsWithUnsaved } from "@/lib/record-tabs";
import { INVOICE_TAB_LABEL, invoiceActionLabels, invoiceTabs, invoiceTitle } from "@/lib/invoice-tabs";

describe("the invoice page's tabs", () => {
  it("names the three tabs in order, Header first", () => {
    expect(invoiceTabs().map((t) => [t.key, t.label])).toEqual([
      ["header", "Header"], ["lines", "Lines"], ["documents", "Documents & history"],
    ]);
    expect(INVOICE_TAB_LABEL).toBe("Invoice sections");
    expect(tabForLocation(invoiceTabs(), "", "")).toBe("header");
    expect(tabForLocation(invoiceTabs(), "", "#history")).toBe("documents");
    expect(tabForLocation(invoiceTabs(), "", "#documents")).toBe("documents");
    expect(tabForLocation(invoiceTabs(), "", "#lines")).toBe("lines");
    expect(tabForLocation(invoiceTabs(), "?tab=lines", "")).toBe("lines");
  });

  it("badges the lines grid's unsaved work on Lines alone (review focus 3)", () => {
    expect([...tabsWithUnsaved(invoiceTabs(), ["Invoice lines"])]).toEqual(["lines"]);
    expect(tabsWithUnsaved(invoiceTabs(), []).size).toBe(0);
  });
});

describe("the title and the action labels", () => {
  it("titles an invoice by its number and a credit by its source invoice's", () => {
    expect(invoiceTitle({ kind: "INVOICE", documentNumber: "IR - 1040", sourceInvoiceNumber: null })).toBe("Invoice IR - 1040");
    expect(invoiceTitle({ kind: "CREDIT", documentNumber: "7", sourceInvoiceNumber: "IR - 1040" })).toBe("Credit from invoice IR - 1040");
    // A credit whose source the read could not name keeps its own number.
    expect(invoiceTitle({ kind: "CREDIT", documentNumber: "7", sourceInvoiceNumber: null })).toBe("Credit 7");
  });

  it("names the six actions by the document's kind", () => {
    expect(invoiceActionLabels("INVOICE")).toEqual({
      finalize: "Finalize invoice", print: "Print invoice", unlock: "Unlock invoice", discard: "Discard invoice",
      recalculate: "Recalculate lines", credit: "Create credit",
    });
    expect(invoiceActionLabels("CREDIT")).toEqual({
      finalize: "Finalize credit", print: "Print credit", unlock: "Unlock credit", discard: "Discard credit",
      recalculate: "Recalculate lines", credit: "Create credit",
    });
  });
});
