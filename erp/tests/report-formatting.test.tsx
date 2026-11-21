import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { BacklogReport } from "@/app/reports/backlog/BacklogReport";
import { ShippedReport } from "@/app/reports/shipped/ShippedReport";
import { SalesReport } from "@/app/reports/sales/SalesReport";
import { PaymentsReport } from "@/app/reports/payments/PaymentsReport";
import { AgingReport } from "@/app/receivables/aging/AgingReport";
import { TurnaroundReport } from "@/app/reports/turnaround/TurnaroundReport";
import { Scoreboard } from "@/app/reports/scoreboard/Scoreboard";
import AuditPage from "@/app/admin/audit/page";
import { headingRowsOf } from "./helpers/markup";
import { BADGE_WARNING, LINK } from "@/lib/ui-classes";

const fixture = vi.hoisted(() => ({
  report: null as object | null, audit: null as object[] | null, pendingLoaded: false,
  // Array states taken in declaration order, for a page whose rows are a bare array (A/R aging:
  // its customer options, then its rows). Ahead of `audit` when set.
  arrays: null as unknown[][] | null,
  permissions: null as string[] | null,
}));
vi.mock("@/lib/use-permissions", () => ({
  usePermissions: () => ({ permissions: fixture.permissions ?? ["reports.view", "customers.view", "parts.view"], error: null }),
}));
// Every report now mounts the shared `ReportsNav` (#303), whose `usePathname` has no App Router to
// read outside `next dev` and returns null there. The pathname is irrelevant to formatting; this
// just supplies one so the bar renders. (`new-shipment-recovery.test.tsx` mocks the same module.)
vi.mock("next/navigation", () => ({ usePathname: () => "/reports" }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // Supply a fetched result and its completed-load flag to the real component's initial
    // render. Each report declares loaded immediately after its result state. Check that
    // shape explicitly instead of silently returning an impossible result-with-loaded=false.
    // All other React state and hooks remain real. Effects do not run in SSR.
    useState: (initial: unknown) => {
      const value = typeof initial === "function" ? initial() : initial;
      const resultState = value && typeof value === "object" &&
        (("groupBy" in value && "rows" in value) || ("window" in value && "invoiced" in value));
      if (resultState && fixture.report) {
        fixture.pendingLoaded = true;
        return actual.useState(fixture.report);
      }
      if (fixture.pendingLoaded) {
        fixture.pendingLoaded = false;
        if (value !== false) throw new Error("Report loaded state must follow its result fixture");
        return actual.useState(true);
      }
      if (Array.isArray(value) && fixture.arrays?.length) return actual.useState(fixture.arrays.shift());
      return actual.useState(Array.isArray(value) && fixture.audit ? fixture.audit : value);
    },
  };
});

beforeEach(() => {
  fixture.report = null; fixture.audit = null; fixture.pendingLoaded = false;
  fixture.arrays = null; fixture.permissions = null;
});

function render(component: ReactElement, report: object): string {
  fixture.report = report;
  fixture.pendingLoaded = false;
  return renderToStaticMarkup(component);
}
function tableRows(html: string, section: "tbody" | "tfoot"): string[][] {
  const content = html.match(new RegExp(`<${section}[^>]*>([\\s\\S]*?)<\\/${section}>`))?.[1] ?? "";
  return [...content.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
      cell[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")));
}
const identity = { customerCode: "C", customerName: "Customer", partNumber: "P", partName: "Part" };

describe("report display formatting", () => {
  it("formats backlog measures and civil date without grouping the order identifier", () => {
    const html = render(<BacklogReport />, { groupBy: "none", totalOrderCount: 1, totalLineCount: 1,
      rows: [{ ...identity, orderId: "o", orderLineId: "l", orderNumber: 1234, qty: 1234, weight: 1234.5, receivedDate: "2026-09-11", daysOpen: 1234 }] });
    expect(tableRows(html, "tbody")[0]).toEqual(["1234", "C · Customer", "P · Part", "1,234", "1,234.50", "09/11/2026", "1,234"]);
    expect(tableRows(html, "tfoot")[0]).toEqual(["Total", "1,234", "1,234.50", ""]);
  });

  it("uses distinct backlog order metadata when per-part counts overlap", () => {
    const html = render(<BacklogReport />, { groupBy: "part", totalOrderCount: 2, totalLineCount: 3,
      rows: [{ key: "a", label: "Part A", orderCount: 2, lineCount: 2, qty: 1000, weight: 1000 },
        { key: "b", label: "Part B", orderCount: 1, lineCount: 1, qty: 234, weight: 234.5 }] });
    expect(tableRows(html, "tfoot")[0]).toEqual(["Total", "2", "3", "1,234", "1,234.50"]);
  });

  it("preserves negative shipped quantities and weights and formats day labels", () => {
    const detail = render(<ShippedReport />, { groupBy: "none", rows: [{ ...identity, shipperId: "s", shipperLineId: "l", shipperNumber: 1234, shipDate: "2026-09-11", qty: -1234, weight: -1234.5 }] });
    // L6: the shipper cell now carries the reversal badge beside the number, so the tag-stripped
    // first cell reads "1234" followed by the badge's own text.
    expect(tableRows(detail, "tbody")[0]).toEqual(["1234Reversal", "09/11/2026", "C · Customer", "P · Part", "-1,234", "-1,234.50"]);
    // The owner's rulings on #825: the subtitle is the report's basis.
    expect(detail).toMatch(/<p\b[^>]*>Basis: Ship date<\/p>/);
    const grouped = render(<ShippedReport />, { groupBy: "day", rows: [{ key: "2026-09-11", label: "2026-09-11", shipmentCount: 1234, qty: 1234, weight: 1234.5 }] });
    expect(tableRows(grouped, "tbody")[0]).toEqual(["09/11/2026", "1,234", "1,234", "1,234.50"]);
  });

  // L6/#232: a reversal is a live negative-qty shipper line, and the detail grid names it with the
  // SAME badge the shipping list uses for the same document state (ShippingList.tsx's
  // `ShippingStatus`). Both directions matter: an ordinary outbound line must not be badged.
  it("badges a shipped reversal line the way the shipping list does, and only that line", () => {
    const line = { ...identity, shipperId: "s", shipperLineId: "l", shipperNumber: 1234, shipDate: "2026-09-11" };
    const reversal = render(<ShippedReport />, { groupBy: "none", rows: [{ ...line, qty: -5, weight: -50 }] });
    expect(reversal).toContain(`<span class="${BADGE_WARNING} ml-1 whitespace-nowrap">Reversal</span>`);
    const outbound = render(<ShippedReport />, { groupBy: "none", rows: [{ ...line, qty: 5, weight: 50 }] });
    expect(outbound).not.toContain("Reversal");
    // The grouped slices net reversals into their group totals and have no per-line grain to badge.
    const grouped2 = render(<ShippedReport />, { groupBy: "customer", rows: [{ key: "c", label: "C", shipmentCount: 1, qty: -5, weight: -50 }] });
    expect(grouped2).not.toContain("Reversal");
  });

  // The weights design §11.3, R1 and R2. Each report writes its weight heading twice, once for the
  // detail view and once for the grouped views, so the heading row is compared whole for the detail
  // view and for one grouped view, by customer. An empty result is enough: the heading row is drawn
  // for it too.
  it.each([
    ["backlog, detail", <BacklogReport key="backlog-detail" />, { groupBy: "none", rows: [], totalOrderCount: 0, totalLineCount: 0 },
      ["Order", "Customer", "Part", "Ordered", "Net weight (lb)", "Received", "Days open"]],
    ["backlog, by customer", <BacklogReport key="backlog-customer" />, { groupBy: "customer", rows: [], totalOrderCount: 0, totalLineCount: 0 },
      ["Customer", "Orders", "Lines", "Ordered", "Net weight (lb)"]],
    ["shipped, detail", <ShippedReport key="shipped-detail" />, { groupBy: "none", rows: [] },
      ["Packing list", "Ship date", "Customer", "Part", "Quantity", "Net weight (lb)"]],
    ["shipped, by customer", <ShippedReport key="shipped-customer" />, { groupBy: "customer", rows: [] },
      ["Customer", "Shipments", "Quantity", "Net weight (lb)"]],
  ])("%s: heads its table with every column, the net weight named", (_view, component, report, headings) => {
    expect(headingRowsOf(render(component as ReactElement, report as object))).toEqual([headings]);
  });

  it.each([
    ["backlog", <BacklogReport key="backlog" />, { totalOrderCount: 1, totalLineCount: 1, orderCount: 1, lineCount: 1, qty: 1, weight: 1 }],
    ["shipped", <ShippedReport key="shipped" />, { shipmentCount: 1, qty: 1, weight: 1 }],
    ["sales", <SalesReport key="sales" />, { total: 1, invoiceCount: 1, revenue: 1 }],
    ["payments", <PaymentsReport key="payments" />, { total: 1, paymentCount: 1, amount: 1, basis: "Posted payments only" }],
    ["turnaround", <TurnaroundReport key="turnaround" />, { orderCount: 1, avgDays: 1, minDays: 1, maxDays: 1 }],
  ])("%s keeps month group labels as months", (_name, component, values) => {
    const html = render(component as ReactElement, { ...values as object, groupBy: "month", rows: [{ ...values as object, key: "2026-09", label: "2026-09" }] });
    expect(tableRows(html, "tbody")[0][0]).toBe("2026-09");
  });

  it("prints a sales credit's figure bare and negative under its ($) heading and retains the finalized date", () => {
    const html = render(<SalesReport />, { groupBy: "none", total: -1234.5, invoiceCount: 1,
      rows: [{ ...identity, invoiceId: "i", documentNumber: "CR-1234", kind: "CREDIT", finalizedDate: "2026-09-11", revenue: -1234.5 }] });
    expect(tableRows(html, "tbody")[0]).toEqual(["CR-1234", "Credit", "C · Customer", "09/11/2026", "-1,234.50"]);
    expect(tableRows(html, "tfoot")[0]).toEqual(["Total", "-1,234.50"]);
    // The summary line has no heading to carry the sign (owner, 2026-11-01 on #825).
    expect(html).toContain("-$1,234.50");
  });

  it("formats payment dates, and bare figures under the ($) heading, in the detail and total", () => {
    const html = render(<PaymentsReport />, { groupBy: "none", total: 1234.5, paymentCount: 1, basis: "Posted payments only",
      rows: [{ ...identity, paymentId: "p", reference: "CHK-1234", paymentTypeName: "Check", receivedDate: "2026-09-11", amount: 1234.5 }] });
    expect(tableRows(html, "tbody")[0]).toEqual(["CHK-1234", "09/11/2026", "C · Customer", "Check", "1,234.50"]);
    expect(tableRows(html, "tfoot")[0]).toEqual(["Total", "1,234.50"]);
    expect(html).toContain("$1,234.50");
  });

  it("retains one decimal for turnaround averages and civil dates for detail", () => {
    const html = render(<TurnaroundReport />, { groupBy: "none", orderCount: 1, avgDays: 1234.5,
      rows: [{ ...identity, orderId: "o", orderNumber: 1234, receivedDate: "2023-04-25", completionDate: "2026-09-11", turnaroundDays: 1234 }] });
    expect(tableRows(html, "tbody")[0]).toEqual(["1234", "C · Customer", "04/25/2023", "09/11/2026", "1,234"]);
    expect(html).toContain(">1,234.5</span> days");
    const grouped = render(<TurnaroundReport />, { groupBy: "customer", orderCount: 1234, avgDays: 1234.5,
      rows: [{ key: "c", label: "Customer", orderCount: 1234, avgDays: 1234.5, minDays: 1000, maxDays: 1500 }] });
    expect(tableRows(grouped, "tbody")[0]).toEqual(["Customer", "1,234", "1,234.5", "1,000", "1,500"]);
  });

  it("distinguishes scoreboard counts, pounds, and signed tax-inclusive dollars", () => {
    const html = render(<Scoreboard />, { window: { from: null, to: null }, ordersEntered: 1234,
      shipped: { qty: 12345, weight: 1234.5 }, invoiced: { invoices: 1234.5, credits: -234.5, net: 1000 } });
    expect(tableRows(html, "tbody")).toEqual([
      ["Orders entered", "by received date", "1,234", "orders"],
      ["Shipped — pieces", "by ship date", "12,345", "pieces"],
      ["Shipped — net weight", "by ship date", "1,234.50", "lb"],
      ["Invoiced — invoice total", "by invoice date, tax included", "$1,234.50", "USD"],
      ["Invoiced — credit total", "by invoice date, tax included", "-$234.50", "USD"],
      ["Invoiced — net total", "by invoice date, tax included", "$1,000.00", "USD"],
    ]);
    expect(html).toContain(">Unit</th>");
    expect(html).toMatch(/text-right[^"]*tabular-nums/);
  });
});

// #637 (owner ruling 2026-11-02): each report's detail row links its first cell to the record it
// lists, as the list pages' rows do, in the shared LINK form. A grouped row names no record and
// links nothing. The Invoice register's Order No stays text (#591) and is not here.
function firstCellLink(html: string): { href: string | null; className: string | null; text: string } | null {
  const body = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const cell = body.match(/<td\b[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? "";
  const a = cell.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/);
  if (!a) return null;
  const attr = (name: string) => a[1].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
  return { href: attr("href"), className: attr("class"), text: a[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&") };
}

describe("report rows link to their records (#637)", () => {
  it.each([
    ["backlog", <BacklogReport key="backlog" />, { groupBy: "none", totalOrderCount: 1, totalLineCount: 1,
      rows: [{ ...identity, orderId: "o-1", orderLineId: "l", orderNumber: 1234, qty: 1, weight: 1, receivedDate: "2026-09-11", daysOpen: 1 }] },
    "/orders/o-1", "1234"],
    ["turnaround", <TurnaroundReport key="turnaround" />, { groupBy: "none", orderCount: 1, avgDays: 1,
      rows: [{ ...identity, orderId: "o-2", orderNumber: 1235, receivedDate: "2026-09-01", completionDate: "2026-09-11", turnaroundDays: 10 }] },
    "/orders/o-2", "1235"],
    ["shipped", <ShippedReport key="shipped" />, { groupBy: "none",
      rows: [{ ...identity, shipperId: "s-1", shipperLineId: "l", shipperNumber: 77, shipDate: "2026-09-11", qty: 1, weight: 1 }] },
    "/shipping/s-1", "77"],
    ["sales", <SalesReport key="sales" />, { groupBy: "none", total: 1, invoiceCount: 1,
      rows: [{ ...identity, invoiceId: "i-1", documentNumber: "INV-1001", kind: "INVOICE", finalizedDate: "2026-09-11", revenue: 1 }] },
    "/invoicing/i-1", "INV-1001"],
    ["payments", <PaymentsReport key="payments" />, { groupBy: "none", total: 1, paymentCount: 1, basis: "Posted payments only",
      rows: [{ ...identity, paymentId: "p-1", batchId: "b-1", reference: "CHK-9", paymentTypeName: "Check", receivedDate: "2026-09-11", amount: 1 }] },
    "/receivables/batches/b-1", "CHK-9"],
  ])("%s: the detail row's first cell links to its record", (_name, component, report, href, text) => {
    expect(firstCellLink(render(component as ReactElement, report as object))).toEqual({ href, className: LINK, text });
  });

  // A payment's reference is optional and stored as "" (receipts.ts): its link reads the em dash
  // format.ts shows for any missing value, so the row's link is never empty.
  it.each([["", "blank"], ["   ", "whitespace"]])("payments: a %s reference's link reads the em dash (%s)", (reference) => {
    const html = render(<PaymentsReport />, { groupBy: "none", total: 1, paymentCount: 1, basis: "Posted payments only",
      rows: [{ ...identity, paymentId: "p-1", batchId: "b-1", reference, paymentTypeName: "Check", receivedDate: "2026-09-11", amount: 1 }] });
    expect(firstCellLink(html)).toEqual({ href: "/receivables/batches/b-1", className: LINK, text: "—" });
  });

  it("shipped: a reversal line's badge stays beside the link, outside it", () => {
    const html = render(<ShippedReport />, { groupBy: "none",
      rows: [{ ...identity, shipperId: "s-1", shipperLineId: "l", shipperNumber: 77, shipDate: "2026-09-11", qty: -1, weight: -1 }] });
    expect(firstCellLink(html)).toEqual({ href: "/shipping/s-1", className: LINK, text: "77" });
    expect(tableRows(html, "tbody")[0][0]).toBe("77Reversal");
  });

  it.each([
    ["backlog", <BacklogReport key="backlog" />, { groupBy: "customer", totalOrderCount: 1, totalLineCount: 1,
      rows: [{ key: "c", label: "C · Customer", orderCount: 1, lineCount: 1, qty: 1, weight: 1 }] }],
    ["sales", <SalesReport key="sales" />, { groupBy: "customer", total: 1, invoiceCount: 1,
      rows: [{ key: "c", label: "C · Customer", invoiceCount: 1, revenue: 1 }] }],
    ["payments", <PaymentsReport key="payments" />, { groupBy: "customer", total: 1, paymentCount: 1, basis: "Posted payments only",
      rows: [{ key: "c", label: "C · Customer", paymentCount: 1, amount: 1 }] }],
  ])("%s: a grouped row links nothing", (_name, component, report) => {
    const html = render(component as ReactElement, report as object);
    expect(tableRows(html, "tbody")[0][0]).toBe("C · Customer");
    expect(html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1]).not.toContain("<a ");
  });

  it("A/R aging: each customer row links to the customer; the family total is the footer and links nothing", () => {
    fixture.permissions = ["receivables.view"];
    const money = { current: 1, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unapplied: 0, net: 1 };
    fixture.arrays = [[], [
      { customerId: "c-1", customerCode: "PAR", customerName: "Parent Co", ...money },
      { customerId: "c-2", customerCode: "KID", customerName: "Child Co", ...money },
      { customerId: "c-1", customerCode: "PAR", customerName: "Parent Co", ...money, net: 2, isFamilyTotal: true },
    ]];
    const html = renderToStaticMarkup(<AgingReport />);
    expect(firstCellLink(html)).toEqual({ href: "/customers/c-1", className: LINK, text: "PAR · Parent Co" });
    const body = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
    expect([...body.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((m) => m[1])).toEqual(["/customers/c-1", "/customers/c-2"]);
    const foot = html.match(/<tfoot[^>]*>([\s\S]*?)<\/tfoot>/)?.[1] ?? "";
    expect(foot).not.toContain("<a ");
  });
});

describe("audit display formatting", () => {
  it("retains browser-local time and exposes the complete visibly shortened identifier", () => {
    fixture.audit = [{ id: "entry", at: new Date(2026, 8, 11, 13, 4, 5).toISOString(), actorName: "Operator", entity: "order", entityId: "abcdefgh12345678", action: "UPDATE", reason: null }];
    const html = renderToStaticMarkup(<AuditPage />);
    const cells = tableRows(html, "tbody")[0];
    expect(cells[0]).toMatch(/^09\/11\/2026,? 0?1:04:05[ \u202f]PM$/);
    expect(cells[2]).toBe("order abcdefgh…");
    expect(html).toContain('title="abcdefgh12345678"');
    expect(html).toMatch(/<span[^>]*class="[^"]*text-ink-500[^"]*"[^>]*>abcdefgh…<\/span>/);
  });

  it("does not append an ellipsis to an identifier that fits", () => {
    fixture.audit = [{ id: "entry", at: "2026-09-11T00:00:00Z", actorName: "Operator", entity: "order", entityId: "short-id", action: "UPDATE", reason: null }];
    const html = renderToStaticMarkup(<AuditPage />);
    expect(tableRows(html, "tbody")[0][2]).toBe("order short-id");
    expect(html).toContain('title="short-id"');
  });
});
