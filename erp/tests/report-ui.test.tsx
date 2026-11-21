import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExportLink } from "@/lib/report-ui";
import { LINK } from "@/lib/ui-classes";

// `ExportLink`, the export link the six report screens and the Invoicing list share (#592 gave it a
// `label`). The repo has no DOM test environment (tests/practice-banner.test.tsx), so it is rendered
// to static markup. The default words matter beyond this file: the reports and
// invoice-shipped-order flows and `e2e/manual-capture.mjs` find the link by the name "Export to
// Excel".

describe("ExportLink — its words and its href", () => {
  it("reads Export to Excel by default, on the inert span and on the live link", () => {
    expect(renderToStaticMarkup(<ExportLink base="/api/invoices/export" query={null} ready={false} />)).toBe(
      '<span aria-disabled="true" title="Loading the current view…" ' +
      'class="cursor-not-allowed text-ink-500 underline">Export to Excel</span>',
    );
    expect(renderToStaticMarkup(<ExportLink base="/api/invoices/export" query="status=FINALIZED" ready />)).toBe(
      `<a href="/api/invoices/export?status=FINALIZED" class="${LINK}">Export to Excel</a>`,
    );
  });

  it("reads the label it is given, on the inert span and on the live link", () => {
    expect(renderToStaticMarkup(
      <ExportLink base="/api/invoices/register" query={null} ready={false} label="Export to PDF" />,
    )).toBe(
      '<span aria-disabled="true" title="Loading the current view…" ' +
      'class="cursor-not-allowed text-ink-500 underline">Export to PDF</span>',
    );
    expect(renderToStaticMarkup(
      <ExportLink base="/api/invoices/register" query="customerId=c1&status=FINALIZED" ready label="Export to PDF" />,
    )).toBe(
      `<a href="/api/invoices/register?customerId=c1&amp;status=FINALIZED" class="${LINK}">Export to PDF</a>`,
    );
  });

  it("builds the href from the query, with no ? for the empty query", () => {
    expect(renderToStaticMarkup(<ExportLink base="/api/invoices/export" query="" ready />)).toBe(
      `<a href="/api/invoices/export" class="${LINK}">Export to Excel</a>`,
    );
  });

  it("stays inert until it is ready and has a query, whatever its label", () => {
    // A query with `ready` false, and `ready` with no query (no load has landed yet): neither links.
    for (const element of [
      <ExportLink key="a" base="/api/invoices/register" query="status=DRAFT" ready={false} label="Export to PDF" />,
      <ExportLink key="b" base="/api/invoices/register" query={null} ready label="Export to PDF" />,
    ]) {
      const markup = renderToStaticMarkup(element);
      expect(markup).not.toContain("<a ");
      expect(markup).toContain(">Export to PDF</span>");
    }
  });
});
