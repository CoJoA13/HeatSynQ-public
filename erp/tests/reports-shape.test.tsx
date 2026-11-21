import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExportLink, GateNotice } from "@/lib/report-ui";
import { BUTTON_NEUTRAL, LINK } from "@/lib/ui-classes";

// How the Reports screens are shaped since PR 10 of the UX redesign (spec §4.3; the owner's rulings
// of 2026-11-01 on #825). What each table prints is tests/report-formatting.test.tsx's.
const read = (page: string) => readFileSync(fileURLToPath(new URL(`../${page}`, import.meta.url)), "utf8");

describe("the export link as a header action", () => {
  it("draws the page's button, live and inert", () => {
    const live = renderToStaticMarkup(<ExportLink base="/x" query="a=1" ready className={BUTTON_NEUTRAL} />);
    expect(live).toContain('href="/x?a=1"');
    expect(live).toContain(`class="${BUTTON_NEUTRAL}"`);
    const inert = renderToStaticMarkup(<ExportLink base="/x" query={null} ready={false} className={BUTTON_NEUTRAL} />);
    expect(inert).toContain('aria-disabled="true"');
    expect(inert).not.toContain("href");
    expect(inert).toContain(`class="${BUTTON_NEUTRAL} cursor-not-allowed opacity-60"`);
  });

  it("stays a text link where no class is handed in, as the Invoicing list's", () => {
    expect(renderToStaticMarkup(<ExportLink base="/x" query="" ready />)).toContain(`class="${LINK}"`);
    expect(renderToStaticMarkup(<ExportLink base="/x" query={null} ready />)).toContain("text-ink-500 underline");
  });
});

describe("the report gate", () => {
  it("sits in the page frame under its header, with no card of its own", () => {
    const html = renderToStaticMarkup(<GateNotice header={<h1>Backlog</h1>} permsError={null} loading={false} deniedMessage="Requires reports.view" />);
    expect(html).toContain('class="min-w-0 p-3 sm:p-6"');
    expect(html).toContain("<h1>Backlog</h1>");
    expect(html).toContain("Requires reports.view");
  });
});

const REPORTS: [file: string, title: string, subtitle: string, exportBase: string][] = [
  ["src/app/reports/backlog/BacklogReport.tsx", "Backlog", "Basis: Received date", "/api/reports/backlog/export"],
  ["src/app/reports/shipped/ShippedReport.tsx", "Shipped", "Basis: Ship date", "/api/reports/shipped/export"],
  ["src/app/reports/turnaround/TurnaroundReport.tsx", "Turnaround", "Basis: Completed date", "/api/reports/turnaround/export"],
  ["src/app/reports/sales/SalesReport.tsx", "Sales", "Basis: Finalized date", "/api/reports/sales/export"],
  ["src/app/reports/payments/PaymentsReport.tsx", "Payments received", "Basis: Received date", "/api/reports/payments/export"],
  ["src/app/reports/scoreboard/Scoreboard.tsx", "Comparison scoreboard", "Basis: Per metric", "/api/reports/scoreboard/export"],
];

describe.each(REPORTS)("%s", (file, title, subtitle, exportBase) => {
  const src = read(file);
  const flat = src.replace(/\s+/g, " ");

  it("titles the gate and the page with PageHeader and the Basis subtitle", () => {
    expect(src.split(`<PageHeader title="${title}"`).length - 1).toBe(2);
    expect(src.split(subtitle).length - 1).toBeGreaterThanOrEqual(2);
    expect(src).not.toContain("<h1");
  });

  it("holds Export in the header's actions, read from the applied query, with Updating… beside it", () => {
    expect(flat).toContain(`<ExportLink base="${exportBase}" query={appliedQuery} ready={exportable} className={BUTTON_NEUTRAL} />`);
    const header = flat.slice(flat.lastIndexOf("<PageHeader"), flat.indexOf("<ExportLink"));
    expect(header).toContain("showingStale && <span");
    expect(src).not.toContain("C9b");
  });

  it("draws the filters in a Report filters card and the table in a flush card", () => {
    expect(src).toContain('<h2 className="mb-2 font-medium">Report filters</h2>');
    expect(flat).toContain("`${CARD_FLUSH} overflow-x-auto ${showingStale ? \"opacity-60\" : \"\"}`");
    expect(src).not.toContain("rounded border bg-surface-0");
    expect(src).toContain("TABLE_HEAD");
  });
});

describe("the owner's renames on #825", () => {
  const text = (file: string) => read(file);
  it("Backlog", () => {
    const src = text(REPORTS[0][0]);
    for (const old of ["Received from", "Received to", "Qty ordered", "Net weight ordered", "No open backlog"]) expect(src).not.toContain(old);
    expect(src).toContain("No matching orders");
    expect(src).toContain("{NET_WEIGHT_LB}");
  });
  it("Shipped", () => {
    const src = text(REPORTS[1][0]);
    for (const old of [">Shipper<", "Qty shipped", "Net weight shipped"]) expect(src).not.toContain(old);
    expect(src).toContain(">Packing list<");
    expect(src).toContain(">Quantity<");
    expect(src).toContain("{NET_WEIGHT_LB}");
  });
  it("Sales and Payments print bare figures under the ($) headings, and $ in the summary line", () => {
    const sales = text(REPORTS[3][0]); const payments = text(REPORTS[4][0]);
    expect(sales).toContain("Revenue, ex-tax ($)");
    expect(sales).not.toContain(">Revenue (ex-tax)<");
    expect(payments).toContain(">Amount ($)<");
    expect(payments).not.toContain(">Amount<");
    for (const src of [sales, payments]) {
      expect(src.split("formatMoney(").length - 1).toBe(1);
      expect(src).toContain("formatMoney(result.total)");
    }
  });
  it("Payments keeps the posted-only pill beside the date basis, in the header", () => {
    const flat = text(REPORTS[4][0]).replace(/\s+/g, " ");
    expect(flat).toContain('subtitle={<>Basis: Received date <span');
    expect(flat).toContain('Basis: {result.basis || "Posted payments only"}</span></>}');
  });
  it("Scoreboard", () => {
    expect(text(REPORTS[5][0])).toContain(">Metric<");
    expect(text(REPORTS[5][0])).not.toContain(">Figure<");
  });
  it("the index", () => {
    expect(text("src/app/reports/ReportsIndex.tsx").split('<PageHeader title="Reports" subtitle="Read-only answers to practical shop questions."').length - 1).toBe(2);
  });
});
