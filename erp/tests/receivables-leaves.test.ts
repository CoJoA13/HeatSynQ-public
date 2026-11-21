// The Receivables pages' leaves (spec 2026-10-30-ux-redesign-design.md §4.3–§4.5; the UX redesign
// PR 7, owner 2026-11-01 on #822): the batch list's three presets over its status filter, the batch
// page's tabs, subtitle, Post confirm and null-figure words, the close page's tabs and subtitle, and
// the two statement confirms' title and body. Each decides on-screen words the pages only draw.
import { describe, expect, it } from "vitest";
import { tabForLocation, tabsWithUnsaved } from "@/lib/record-tabs";
import { RECEIVABLES_PRESETS, RECEIVABLES_VIEWS_LABEL, applyPreset, presetFor } from "@/lib/receivables-presets";
import {
  RECEIPT_BATCH_TAB_LABEL, balanceText, batchSubtitle, controlTotalText, postConfirm, receiptBatchTabs,
} from "@/lib/receipt-batch-page";
import { CLOSE_TAB_LABEL, closeSubtitle, closeTabs } from "@/lib/close-tabs";
import { perDivisionConfirm, runConfirm } from "@/lib/statement-confirms";

describe("the batch list's presets", () => {
  it("names the three in order and the group", () => {
    expect(RECEIVABLES_PRESETS.map((p) => [p.key, p.label])).toEqual([["open", "Open"], ["posted", "Posted"], ["all", "All"]]);
    expect(RECEIVABLES_VIEWS_LABEL).toBe("Batch views");
  });

  it("applies each as a setting of the status filter and derives it back: the three cover the filter's range", () => {
    expect(applyPreset({ status: "" as const, other: 1 }, "open")).toEqual({ status: "OPEN", other: 1 });
    expect(applyPreset({ status: "OPEN" as const }, "posted")).toEqual({ status: "POSTED" });
    expect(applyPreset({ status: "POSTED" as const }, "all")).toEqual({ status: "" });
    expect(presetFor({ status: "OPEN" })).toBe("open");
    expect(presetFor({ status: "POSTED" })).toBe("posted");
    expect(presetFor({ status: "" })).toBe("all");
  });
});

describe("the batch page's leaf", () => {
  it("names the two tabs, History reached by its hash, the apply grid's registry label badging Payments", () => {
    expect(receiptBatchTabs().map((t) => [t.key, t.label])).toEqual([["payments", "Payments"], ["history", "History"]]);
    expect(RECEIPT_BATCH_TAB_LABEL).toBe("Batch sections");
    expect(tabForLocation(receiptBatchTabs(), "", "")).toBe("payments");
    expect(tabForLocation(receiptBatchTabs(), "", "#history")).toBe("history");
    expect(tabForLocation(receiptBatchTabs(), "", "#add-payment")).toBe("payments");
    expect([...tabsWithUnsaved(receiptBatchTabs(), ["Payment application"])]).toEqual(["payments"]);
    expect(tabsWithUnsaved(receiptBatchTabs(), []).size).toBe(0);
  });

  it("writes the subtitle from the deposit date, the status and a void", () => {
    expect(batchSubtitle({ depositDate: "2026-10-29", status: "OPEN", deletedAt: null })).toBe("10/29/2026 · Open");
    expect(batchSubtitle({ depositDate: "2026-10-29", status: "POSTED", deletedAt: null })).toBe("10/29/2026 · Posted");
    expect(batchSubtitle({ depositDate: "2026-10-29", status: "OPEN", deletedAt: "2026-10-30T12:00:00Z" })).toBe("10/29/2026 · Open · Voided");
  });

  it("splits the Post confirm into the ruled title and body", () => {
    expect(postConfirm(42)).toEqual({
      title: "Post batch #42?", body: "Once posted, no further payments can be added or voided.", confirm: "Post batch",
    });
  });

  it("names a null control total and a null balance in words (owner rename; #163)", () => {
    expect(controlTotalText(null)).toBe("Not entered");
    expect(controlTotalText(1250)).toBe("$1,250.00");
    expect(balanceText(null)).toBe("Not proved — no control total");
    expect(balanceText(0)).toBe("$0.00");
    expect(balanceText(-250)).toBe("-$250.00");
  });
});

describe("the close page's leaf", () => {
  it("names the two tabs and the ids a hash may target", () => {
    expect(closeTabs().map((t) => [t.key, t.label])).toEqual([["reconcile", "Reconcile"], ["closed", "Closed periods"]]);
    expect(CLOSE_TAB_LABEL).toBe("Close sections");
    expect(tabForLocation(closeTabs(), "?year=2026&month=9", "")).toBe("reconcile");
    expect(tabForLocation(closeTabs(), "?year=2026&month=9&tab=closed", "")).toBe("closed");
    expect(tabForLocation(closeTabs(), "", "#closed-periods")).toBe("closed");
    expect(tabForLocation(closeTabs(), "", "#readiness")).toBe("reconcile");
  });

  it("writes the subtitle with the period when one is committed", () => {
    expect(closeSubtitle("September 2026")).toBe("September 2026 · Review, reconcile, close, export.");
    expect(closeSubtitle(null)).toBe("Review, reconcile, close, export.");
  });
});

describe("the statement confirms", () => {
  it("split today's per-division sentence into its title and body", () => {
    expect(perDivisionConfirm(3, "2026-10-29", "NST-E, NST-W (inactive)")).toEqual({
      title: "Print 3 statements as of 2026-10-29 — this customer plus its divisions (NST-E, NST-W (inactive))?",
      body: "The preview above shows this customer's statement only; each division's is archived and listed with a link once printed.",
      confirm: "Print statements",
    });
  });

  it("keep today's run question as the title", () => {
    expect(runConfirm("2026-10-29")).toEqual({
      title: "Print a statement for every customer with an open balance as of 2026-10-29?", body: "", confirm: "Run statements",
    });
  });
});
