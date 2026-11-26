import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardTable, type BoardRow } from "@/app/board-parts/BoardTable";
import { ColumnPicker } from "@/app/board-parts/ColumnPicker";
import { FilterBar } from "@/app/board-parts/FilterBar";
import { BOARD_COLUMNS, defaultColumnState, defaultFilters } from "@/lib/board-columns";
import { headingRowsOf } from "./helpers/markup";

const noop = () => {};

function exactTextOpeningTag(html: string, element: string, text: string): string {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<${element}\\b[^>]*>\\s*${escaped}\\s*<\\/${element}>`));
  expect(match, `${text} should be the complete text of <${element}>`).not.toBeNull();
  return match![0].slice(0, match![0].indexOf(">") + 1);
}

function tableHeader(html: string, label: string): string {
  const header = html.match(/<th\b[^>]*>[\s\S]*?<\/th>/g)?.find((candidate) =>
    candidate.replace(/<[^>]+>/g, "").trim().startsWith(label),
  );
  expect(header, `${label} header should be rendered`).toBeDefined();
  return header!;
}

function hasAccessibleName(html: string, tag: string, name: string): boolean {
  const controls = html.match(new RegExp(`<${tag}\\b[^>]*>`, "g")) ?? [];
  const attribute = (markup: string, attr: string) =>
    markup.match(new RegExp(`\\s${attr}="([^"]*)"`))?.[1];
  const textById = (id: string) => {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const element = html.match(new RegExp(
      `<([a-z][\\w:-]*)\\b[^>]*\\sid="${escapedId}"[^>]*>([\\s\\S]*?)<\\/\\1>`, "i",
    ));
    return element?.[2].replace(/<[^>]+>/g, "").trim();
  };

  for (const control of controls) {
    if (attribute(control, "aria-label") === name) return true;
    const labelledBy = attribute(control, "aria-labelledby");
    if (labelledBy && labelledBy.split(/\s+/).map(textById).filter(Boolean).join(" ") === name) {
      return true;
    }
  }

  const labels = html.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) ?? [];
  return labels.some((label) => {
    if (label.replace(/<[^>]+>/g, "").trim() !== name) return false;
    const targetId = attribute(label.slice(0, label.indexOf(">") + 1), "for");
    if (targetId) return controls.some((control) => attribute(control, "id") === targetId);
    return new RegExp(`<${tag}\\b`).test(label);
  });
}

const row: BoardRow = {
  id: "order-17",
  orderNumber: 1042,
  customerCode: "ACME",
  customerName: "Acme Heat Treating",
  leadPartNumber: "PART-1",
  poNumber: "PO-9",
  vsOrderNumber: "VS-4",
  qty: 12,
  weight: 35,
  receivedDate: "2026-09-01",
  requestDate: "2026-09-10",
  targetDate: "2026-09-08",
  status: "OPEN",
  voided: false,
  light: "on_target",
  loadCount: 1,
  linked: true,
};

describe("order board native controls (#224)", () => {
  it("renders the identifying order number as a link to its order", () => {
    const html = renderToStaticMarkup(
      <BoardTable rows={[row]} loaded visibleDefs={[BOARD_COLUMNS[0]]}
                  sort={{ sort: "orderNumber", dir: "desc" }}
                  onToggleSort={noop} onOpenOrder={noop} />,
    );

    const link = exactTextOpeningTag(html, "a", "1042");
    expect(link).toContain('href="/orders/order-17"');
  });

  it("uses buttons for sortable headings and exposes the current sort direction", () => {
    const html = renderToStaticMarkup(
      <BoardTable rows={[]} loaded visibleDefs={[BOARD_COLUMNS[0], BOARD_COLUMNS[1], BOARD_COLUMNS[2]]}
                  sort={{ sort: "customerCode", dir: "asc" }}
                  onToggleSort={noop} onOpenOrder={noop} />,
    );

    const order = tableHeader(html, "Order #");
    const customer = tableHeader(html, "Customer");
    const leadPart = tableHeader(html, "Lead part");
    expect(order).toContain('aria-sort="none"');
    expect(order).toMatch(/<button[^>]*type="button"[^>]*>[^<]*Order #/);
    expect(customer).toContain('aria-sort="ascending"');
    expect(customer).toMatch(/<button[^>]*type="button"[^>]*>[^<]*Customer/);
    expect(leadPart).not.toContain("aria-sort=");
    expect(leadPart).not.toContain("<button");

    const descending = renderToStaticMarkup(
      <BoardTable rows={[]} loaded visibleDefs={[BOARD_COLUMNS[1]]}
                  sort={{ sort: "customerCode", dir: "desc" }}
                  onToggleSort={noop} onOpenOrder={noop} />,
    );
    expect(tableHeader(descending, "Customer")).toContain('aria-sort="descending"');
  });

  it("labels every column visibility checkbox and gives reorder buttons distinct names", () => {
    const html = renderToStaticMarkup(
      <ColumnPicker columns={defaultColumnState().slice(0, 2)}
                    onToggleVisible={noop} onMove={noop} />,
    );

    expect(hasAccessibleName(html, "input", "Order #")).toBe(true);
    expect(hasAccessibleName(html, "input", "Customer")).toBe(true);
    expect(hasAccessibleName(html, "button", "Move Order # up")).toBe(true);
    expect(hasAccessibleName(html, "button", "Move Order # down")).toBe(true);
    expect(hasAccessibleName(html, "button", "Move Customer up")).toBe(true);
    expect(hasAccessibleName(html, "button", "Move Customer down")).toBe(true);
    expect(exactTextOpeningTag(html, "button", "↑")).toContain('disabled=""');
  });

  it("associates names with search, customer, and each date endpoint", () => {
    const html = renderToStaticMarkup(
      <FilterBar filters={defaultFilters()} customers={[]}
                 customersGate={{ allowed: true, disabled: false, title: undefined }}
                 queryString="" columnsOpen={false} onUpdateFilters={noop}
                 onToggleStatus={noop} onToggleColumnsOpen={noop} />,
    );

    expect(hasAccessibleName(html, "input", "Search")).toBe(true);
    expect(hasAccessibleName(html, "input", "Customer")).toBe(true);
    expect(hasAccessibleName(html, "input", "Received from")).toBe(true);
    expect(hasAccessibleName(html, "input", "Received to")).toBe(true);
    expect(hasAccessibleName(html, "input", "Request from")).toBe(true);
    expect(hasAccessibleName(html, "input", "Request to")).toBe(true);
  });
});

describe("order board: the weight column's words (the weights design §11.3, O12 to O14)", () => {
  it("heads the weight column Net weight (lb) on the default board", () => {
    const html = renderToStaticMarkup(
      <BoardTable rows={[]} loaded visibleDefs={BOARD_COLUMNS}
                  sort={{ sort: "orderNumber", dir: "desc" }}
                  onToggleSort={noop} onOpenOrder={noop} />,
    );
    // The whole heading row. "Order #" carries the arrow of the default sort.
    expect(headingRowsOf(html)).toEqual([[
      "Order # ▼", "Customer", "Lead part", "PO", "Qty", "Net weight (lb)", "Received", "Request", "Target",
      "Status", "Loads", "Linked", "VS #"]]);
  });

  it("names the Columns panel's weight row and its two buttons by that heading", () => {
    const columns = defaultColumnState().filter((c) => c.key === "qty" || c.key === "weight");
    const html = renderToStaticMarkup(<ColumnPicker columns={columns} onToggleVisible={noop} onMove={noop} />);
    for (const [tag, name] of [["input", "Net weight (lb)"], ["button", "Move Net weight (lb) up"],
      ["button", "Move Net weight (lb) down"]] as const) {
      expect(hasAccessibleName(html, tag, name), name).toBe(true);
    }
  });
});

describe("order board: the net weight heading's cell (the owner's ruling of 2026-10-15, #527)", () => {
  it("the cell carries lg:whitespace-nowrap and no bare whitespace-nowrap", () => {
    const html = renderToStaticMarkup(
      <BoardTable rows={[]} loaded visibleDefs={BOARD_COLUMNS}
                  sort={{ sort: "orderNumber", dir: "desc" }}
                  onToggleSort={noop} onOpenOrder={noop} />,
    );
    // The classes of each heading cell that reads "Net weight (lb)" on the default board, the rule
    // chosen for the invoice page on 2026-10-10 (tests/operational-formatting.test.tsx holds it
    // there). `lg:whitespace-nowrap` is Tailwind's one-line class from its `lg` breakpoint up,
    // 64rem by Tailwind's default, which is 1024 px. A bare `whitespace-nowrap` is the same class
    // at every width, and is refused. One answer per cell found, so a heading that is not found
    // answers `[]` and fails both. It does not hold the lines the heading takes, or that no other
    // class (another breakpoint's nowrap, `text-nowrap`) keeps it from wrapping below 1024 px:
    // only a browser shows those.
    const held = (html.match(/<th\b[^>]*>[\s\S]*?<\/th>/g) ?? [])
      .filter((th) => th.replace(/<[^>]+>/g, "").trim() === "Net weight (lb)")
      .map((th) => /^<th\b[^>]*\sclass="([^"]*)"/.exec(th)?.[1].split(" ") ?? []);
    expect(held.map((classes) => classes.includes("lg:whitespace-nowrap"))).toEqual([true]);
    expect(held.map((classes) => classes.includes("whitespace-nowrap"))).toEqual([false]);
  });
});
