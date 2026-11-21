import { describe, expect, it } from "vitest";
import { buildBacklog, type BacklogGroupBy, type OpenLine } from "@/server/reports/backlog";

const lines: OpenLine[] = [
  { orderId: "order-a", orderLineId: "line-a", orderNumber: 1001, customerId: "customer-a", customerCode: "A", customerName: "Alpha", partId: "part-a", partNumber: "PA", partName: "Part A", qty: 1000, weight: 1250.25, receivedDate: "2026-09-01" },
  { orderId: "order-a", orderLineId: "line-b", orderNumber: 1001, customerId: "customer-a", customerCode: "A", customerName: "Alpha", partId: "part-b", partNumber: "PB", partName: "Part B", qty: 2, weight: 0.25, receivedDate: "2026-09-01" },
  { orderId: "order-b", orderLineId: "line-c", orderNumber: 1002, customerId: "customer-b", customerCode: "B", customerName: "Beta", partId: "part-a", partNumber: "PA", partName: "Part A", qty: 3, weight: 0.5, receivedDate: "2026-08-31" },
];
const groupings: BacklogGroupBy[] = ["none", "customer", "part", "month"];

describe("Backlog totals across displayed groupings", () => {
  it.each(groupings)("%s retains one count per order and per line", (groupBy) => {
    const result = buildBacklog(lines, { today: "2026-09-11", groupBy });
    expect(result).toMatchObject({ totalOrderCount: 2, totalLineCount: 3 });
    expect(result.rows.reduce((sum, row) => sum + row.qty, 0)).toBe(1005);
    expect(result.rows.reduce((sum, row) => sum + row.weight, 0)).toBe(1251);
  });

  it("does not add per-part order counts when one order has multiple parts", () => {
    const result = buildBacklog(lines, { today: "2026-09-11", groupBy: "part" });
    if (result.groupBy === "none") throw new Error("Expected grouped fixture");
    expect(result.rows.reduce((sum, row) => sum + row.orderCount, 0)).toBe(3);
    expect(result).toMatchObject({ totalOrderCount: 2, totalLineCount: 3 });
  });

  it.each(groupings)("empty %s has explicit zero totals", (groupBy) => {
    expect(buildBacklog([], { today: "2026-09-11", groupBy }))
      .toMatchObject({ rows: [], totalOrderCount: 0, totalLineCount: 0 });
  });

  it("counts only the filtered lines it receives, without changing their values", () => {
    const input = lines.slice(1);
    const before = structuredClone(input);
    expect(buildBacklog(input, { today: "2026-09-11", groupBy: "part" }))
      .toMatchObject({ totalOrderCount: 2, totalLineCount: 2 });
    expect(input).toEqual(before);
  });
});
