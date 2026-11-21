import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { summarizeLoadAllocation } from "@/lib/load-allocation";
import { LoadAllocationSummary } from "@/app/orders/[id]/LoadAllocationSummary";

const lines = [{ qty: 40, weight: 4.1 }, { qty: 10, weight: 0.2 }];
const rows = [{ qty: "30", weight: "2.10" }, { qty: "20", weight: "2.20" }];

// Hand-calculated fixtures catch excluding riders, floating-point comparisons, and treating
// missing or malformed editor input as a confirmed allocation. No server or DB is needed.
describe("load allocation totals", () => {
  it("includes every line, including rider quantities and weights", () => {
    expect(summarizeLoadAllocation(rows, lines)).toEqual({
      quantity: { allocated: BigInt(50), ordered: BigInt(50), difference: BigInt(0), incomplete: false },
      weight: { allocated: BigInt(430), ordered: BigInt(430), difference: BigInt(0), incomplete: false },
    });
  });

  it("reports under-allocation and over-allocation with exact decimal differences", () => {
    const summary = summarizeLoadAllocation([{ qty: 49, weight: "4.31" }], lines);
    expect(summary.quantity.difference).toBe(BigInt(-1));
    expect(summary.weight.difference).toBe(BigInt(1));
  });

  it("does not introduce a mismatch from 0.1 plus 0.2", () => {
    const summary = summarizeLoadAllocation([{ qty: 1, weight: "0.10" }, { qty: 1, weight: "0.20" }], [{ qty: 2, weight: 0.3 }]);
    expect(summary.weight.difference).toBe(BigInt(0));
  });

  it("keeps accumulated cents exact beyond Number.MAX_SAFE_INTEGER", () => {
    const summary = summarizeLoadAllocation(
      Array.from({ length: 10_000 }, () => ({ qty: 1, weight: "9999999999.99" })),
      Array.from({ length: 10_000 }, () => ({ qty: 1, weight: 9999999999.99 })),
    );
    expect(summary.weight.allocated).toBe(BigInt("9999999999990000"));
    expect(summary.weight.difference).toBe(BigInt(0));
  });

  it("counts null and blank values as zero while explicitly marking their metric incomplete", () => {
    const summary = summarizeLoadAllocation([{ qty: null, weight: "1.00" }, { qty: "50", weight: " " }], lines);
    expect(summary.quantity).toEqual({ allocated: BigInt(50), ordered: BigInt(50), difference: BigInt(0), incomplete: true });
    expect(summary.weight).toEqual({ allocated: BigInt(100), ordered: BigInt(430), difference: BigInt(-330), incomplete: true });
  });

  it("does not confuse a legal zero weight with a missing weight", () => {
    const summary = summarizeLoadAllocation([{ qty: "1", weight: "0" }], [{ qty: 1, weight: 0 }]);
    expect(summary.weight).toEqual({ allocated: BigInt(0), ordered: BigInt(0), difference: BigInt(0), incomplete: false });
  });

  it.each(["bad", "0", "-1", "1.5", "2147483648", Infinity, NaN])("does not total invalid quantity %s as zero", qty => {
    const summary = summarizeLoadAllocation([{ qty, weight: "4.30" }], lines);
    expect(summary.quantity.allocated).toBeNull();
    expect(summary.quantity.difference).toBeNull();
    expect(summary.weight.difference).toBe(BigInt(0));
  });

  it.each(["bad", "-0.01", "0.001", "10000000000", "1e2", Infinity, NaN])("does not total invalid weight %s as zero", weight => {
    const summary = summarizeLoadAllocation([{ qty: "50", weight }], lines);
    expect(summary.weight.allocated).toBeNull();
    expect(summary.weight.difference).toBeNull();
    expect(summary.quantity.difference).toBe(BigInt(0));
  });

  it.each([[".5", 50], ["0.36000", 36], ["1.50", 150], ["0.00", 0], ["4.", null]])("reads a load weight %j as %s cents", (weight, cents) => {
    const summary = summarizeLoadAllocation([{ qty: "50", weight }], lines);
    expect(summary.weight.allocated).toBe(cents === null ? null : BigInt(cents));
  });

  it("does not label an empty load collection complete", () => {
    const summary = summarizeLoadAllocation([], lines);
    expect(summary.quantity.incomplete).toBe(true);
    expect(summary.weight.incomplete).toBe(true);
  });

  it("does not compare malformed or missing order totals", () => {
    expect(summarizeLoadAllocation(rows, [{ qty: NaN, weight: Infinity }]).quantity.ordered).toBeNull();
    expect(summarizeLoadAllocation(rows, []).weight.ordered).toBeNull();
  });
});

describe("load allocation summary display", () => {
  function render(props: Partial<Parameters<typeof LoadAllocationSummary>[0]> = {}) {
    return renderToStaticMarkup(<LoadAllocationSummary rows={rows} lines={lines} dirty={false} ready={true} {...props} />);
  }

  it("shows saved allocation against the whole order with quantity and weight units", () => {
    const html = render();
    expect(html).toContain("50 / 50");
    expect(html).toContain("4.30 / 4.30");
    expect(html).toContain("lb");
    expect(html).toContain("Matches order");
    expect(html).not.toContain("Unsaved");
  });

  it("labels its two figures Quantity and Net weight (the weights design §11.3, O10)", () => {
    // The text of each <dt>, whole and in order. "Weight" alone is not "Net weight", and a card
    // that draws no <dt> fails.
    const labels = (render().match(/<dt\b[^>]*>[^<]*<\/dt>/g) ?? []).map((dt) => dt.replace(/<[^>]+>/g, ""));
    expect(labels).toEqual(["Quantity", "Net weight"]);
  });

  it("marks edited totals unsaved and shows both mismatch directions", () => {
    const html = render({ rows: [{ qty: "49", weight: "4.31" }], dirty: true });
    expect(html).toContain("Unsaved");
    expect(html).toContain("1 pcs remaining");
    expect(html).toContain("0.01 lb over");
  });

  it("shows no numerical totals before draft recovery is ready", () => {
    const html = render({ ready: false });
    expect(html).toContain("available");
    expect(html).not.toContain("50 / 50");
    expect(html).not.toContain("Matches order");
  });

  it("does not claim blank fields match even when known allocations equal the order", () => {
    const html = render({ rows: [...rows, { qty: "", weight: "" }] });
    expect(html).toContain("Incomplete");
    expect(html).not.toContain("Matches order");
  });

  it("shows invalid totals as unavailable instead of zero or a match", () => {
    const html = render({ rows: [{ qty: "bad", weight: "bad" }] });
    expect(html).toContain("Invalid");
    expect(html).toContain("—");
    expect(html).not.toContain("Matches order");
    expect(html).not.toContain("0 / 50");
  });
});
