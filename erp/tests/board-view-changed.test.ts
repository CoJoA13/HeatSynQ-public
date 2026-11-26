import { describe, expect, it } from "vitest";
import { defaultViewConfig, sameViewConfig, type ViewConfig } from "@/lib/board-columns";

// Ruling R20 (owner 2026-10-22, #683): the board's View select shows "(changed)" while the live
// arrangement differs from the selected saved view's stored one, and Update view writes it back.
// `sameViewConfig` is the comparison, against the NORMALISED stored config, so a view saved before
// a column existed does not read as changed by that alone; the status filter is a set. Mutation:
// compare the raw stored config and the last case reds; compare status as an ordered list and the
// set case reds.
const live = (): ViewConfig => defaultViewConfig();

describe("sameViewConfig", () => {
  it("a stored config equal to the live one, normalised, is the same", () => {
    expect(sameViewConfig(live(), defaultViewConfig())).toBe(true);
  });

  it("column order, column visibility, sort and direction each count", () => {
    const base = live();
    const reordered = { ...base, columns: [base.columns[1], base.columns[0], ...base.columns.slice(2)] };
    expect(sameViewConfig(reordered, base)).toBe(false);
    const hidden = { ...base, columns: base.columns.map((c, i) => (i === 0 ? { ...c, visible: !c.visible } : c)) };
    expect(sameViewConfig(hidden, base)).toBe(false);
    expect(sameViewConfig({ ...base, dir: base.dir === "asc" ? "desc" : "asc" }, base)).toBe(false);
    expect(sameViewConfig({ ...base, sort: "orderNumber" }, { ...base, sort: "customerCode" })).toBe(false);
  });

  it("the status filter is a set: the same statuses in another order are the same view", () => {
    const base = live();
    const a: ViewConfig = { ...base, filters: { ...base.filters, status: ["OPEN", "SHIPPED"] } };
    const b: ViewConfig = { ...base, filters: { ...base.filters, status: ["SHIPPED", "OPEN"] } };
    expect(sameViewConfig(a, b)).toBe(true);
    expect(sameViewConfig(a, { ...base, filters: { ...base.filters, status: ["OPEN"] } })).toBe(false);
  });

  it("every other filter counts", () => {
    const base = live();
    for (const [key, value] of [["search", "acme"], ["customerId", "c1"], ["receivedFrom", "2026-10-01"], ["includeVoided", true]] as const) {
      expect(sameViewConfig({ ...base, filters: { ...base.filters, [key]: value } }, base), key).toBe(false);
    }
  });

  it("a stored config saved before a column existed is compared normalised, so the new column alone changes nothing", () => {
    const base = live();
    const stored = { columns: base.columns.slice(0, -1), filters: base.filters, sort: base.sort, dir: base.dir };
    expect(sameViewConfig(base, stored)).toBe(true);
    // A null config reads as the default columns and sort and no status filter (#1057: never as the
    // board's opening Open orders), so it matches the board with every status box clear.
    expect(sameViewConfig({ ...base, filters: { ...base.filters, status: [] } }, null)).toBe(true);
    expect(sameViewConfig(base, null)).toBe(false);
  });
});
