import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardTable, type BoardRow } from "@/app/board-parts/BoardTable";
import { InvoiceLinesGrid, type InvoiceLineRow } from "@/app/invoicing/[id]/InvoiceDetail";
import { StepSuggestionList } from "@/app/invoicing/[id]/StepWordsBox";
import { QuotePartSummary } from "@/app/quotes/[id]/QuoteDetail";
import { BOARD_COLUMNS } from "@/lib/board-columns";

import { emptyBulkDraft } from "@/lib/bulk-grid-recovery";
import { toLineFields } from "@/lib/invoice-bulk-recovery";
import type { InvoiceKindValue } from "@/lib/invoice-constants";
import type { InvoiceStepSuggestions } from "@/lib/invoice-step-suggestions";
import { BADGE_WARNING } from "@/lib/ui-classes";

// SSR has no authenticated browser draft store. Supply the already-authorized
// store view at its subscription seam; actual bulk composition and InvoiceLinesGrid
// formatting/rendering remain production code, including readonly recovery display.
const recoveryFixture = vi.hoisted(() => ({ view: undefined as unknown }));
vi.mock("@/lib/use-recoverable-draft", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/use-recoverable-draft")>(),
  useRecoverableDraft: () => recoveryFixture.view,
}));

const row: BoardRow = {
  id: "order-238", orderNumber: 12345, customerCode: "DEMO", customerName: "Demo Shop",
  leadPartNumber: "PART-12345", poNumber: "12345", vsOrderNumber: "12345",
  qty: 12345, weight: 12345.5, loadCount: 1234,
  receivedDate: "2026-09-01", requestDate: "2026-10-02", targetDate: "2026-09-30",
  status: "OPEN", voided: false, light: "on_target", linked: false,
};

function renderBoard(overrides: Partial<BoardRow> = {}) {
  return renderToStaticMarkup(<BoardTable rows={[{ ...row, ...overrides }]} loaded
    visibleDefs={BOARD_COLUMNS} sort={{ sort: "receivedDate", dir: "asc" }}
    onToggleSort={() => {}} onOpenOrder={() => {}} />);
}

function cells(html: string, tag: "td" | "th") {
  return html.match(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "g")) ?? [];
}

function text(markup: string) { return markup.replace(/<[^>]+>/g, "").trim(); }

function column(html: string, key: string, tag: "td" | "th" = "td") {
  return cells(html, tag)[BOARD_COLUMNS.findIndex((column) => column.key === key)];
}

describe("operational display formatting (#238)", () => {
  it("groups counts and shows weight with two decimal places in the actual board", () => {
    const html = renderBoard();
    expect(text(column(html, "qty"))).toBe("12,345");
    expect(text(column(html, "weight"))).toBe("12,345.50");
    expect(text(column(html, "loads"))).toBe("1,234");
  });

  it("renders calendar dates uniformly and preserves an absent target", () => {
    const html = renderBoard();
    expect(text(column(html, "received"))).toBe("09/01/2026");
    expect(text(column(html, "request"))).toBe("10/02/2026");
    expect(text(column(html, "target"))).toBe("09/30/2026");
    expect(text(column(renderBoard({ targetDate: null }), "target"))).toBe("—");
  });

  it.each(["qty", "weight", "loads"])("aligns the %s heading and figures together", (key) => {
    const html = renderBoard();
    expect(column(html, key, "th")).toMatch(/class="[^"]*\btext-right\b/);
    expect(column(html, key)).toMatch(/class="[^"]*\btext-right\b/);
    expect(column(html, key)).toMatch(/class="[^"]*\btabular-nums\b/);
  });

  it("leaves identifiers and server sort fields unformatted", () => {
    const html = renderBoard();
    expect(text(column(html, "orderNumber"))).toBe("12345");
    expect(column(html, "orderNumber")).toContain('href="/orders/order-238"');
    expect(text(column(html, "po"))).toBe("12345");
    expect(text(column(html, "vsNumber"))).toBe("12345");
    expect(column(html, "received", "th")).toContain('aria-sort="ascending"');
    expect(column(html, "received", "th")).toContain("Received ▲");
    expect(column(html, "qty", "th")).not.toContain("aria-sort");
    expect(column(html, "qty", "th")).not.toContain("<button");

    const onToggleSort = vi.fn();
    const rendered = BoardTable({ rows: [row], loaded: true, visibleDefs: BOARD_COLUMNS,
      sort: { sort: "receivedDate", dir: "asc" }, onToggleSort, onOpenOrder: () => {} });
    const table = rendered.props.children;
    const thead = table.props.children[0];
    const headings = thead.props.children.props.children;
    const received = headings[BOARD_COLUMNS.findIndex((definition) => definition.key === "received")];
    received.props.children.props.onClick();
    expect(onToggleSort).toHaveBeenCalledExactlyOnceWith(BOARD_COLUMNS.find((definition) => definition.key === "received"));
    expect(row.receivedDate).toBe("2026-09-01");
    expect(row.qty).toBe(12345);
    expect(row.weight).toBe(12345.5);
  });
});


const invoiceLine: InvoiceLineRow = {
  id: "line-238", position: 1, kind: "OPERATION", parentLineId: null,
  orderLineId: null, processStepCodeId: null, surchargeId: null, orderChargeId: null, glAccountId: null,
  partNumber: "PART-238", partName: "Fixture", partDescription: "Fixture part",
  description: "Heat treatment", glAccountName: "Sales", qty: 1000, weight: 1000.5, eachWeight: 1.0005,
  pricePer: "EACH", unitPrice: 1234.5678, setupCharge: null, minimumCharge: null,
  breakThreshold: null, minimumApplied: false, rate: 0.075, priceSource: "MANUAL",
  sourceQuoteNumber: null, needsPrice: false, wordsChosen: false, amount: 12345.5,
};

function renderInvoiceLine(kind: InvoiceLineRow["kind"], allowed: boolean, amount = invoiceLine.amount, recovering = false, readOnly = false, over: Partial<InvoiceLineRow> = {},
  extra: { invoiceKind?: InvoiceKindValue; stepSuggestions?: InvoiceStepSuggestions | null } = {}) {
  const lines = [{ ...invoiceLine, kind, amount, ...over }];
  const baseline = { rows: lines.map(line => ({ id: line.id, fields: toLineFields(line) })), context: {} };
  recoveryFixture.view = { mode: recovering ? "offer" : "editing", savedBaseline: baseline,
    current: { data: emptyBulkDraft(), baseline, stamp: { key: { owner: { userId: "fixture", authGeneration: 1 }, record: { kind: "invoice", id: "invoice-238" }, editor: "invoice-lines" }, generation: 1, version: 1 } },
    canRestore: recovering, needsRefresh: false };
  const recoverySource = { read: vi.fn(), register: vi.fn(), begin: vi.fn() };
  const html = renderToStaticMarkup(<InvoiceLinesGrid invoiceId="invoice-238" lines={lines} kind={extra.invoiceKind ?? "INVOICE"}
    stepSuggestions={extra.stepSuggestions} recoverySource={recoverySource} moneyGate={{ allowed, disabled: !allowed, title: allowed ? undefined : "Read-only invoice" }}
    applyMutation={async () => {}} readOnly={readOnly} />);
  expect(lines[0].amount).toBe(amount);
  expect(lines[0].unitPrice).toBe(1234.5678);
  return html;
}

/** The finalized branch (S3): same arguments, `readOnly` on. `moneyGate` is passed LOCKED, which is
 *  what `statusLocked` hands the real component for a finalized invoice. */
function renderFinalizedLine(kind: InvoiceLineRow["kind"], over: Partial<InvoiceLineRow> = {}) {
  return renderInvoiceLine(kind, false, invoiceLine.amount, false, true, over);
}

/**
 * A finalized invoice exactly as the DRAFT STORE projects one, which the helper above does not
 * model: `invoiceLinesBaseline` reports `editable: false` for a FINALIZED status, and
 * `draft-store.ts`'s `emit` then yields mode **"conflict"** with no retained copy — never
 * "editing". `readOnly` is the caller's choice so the same view can be rendered through both
 * branches, which is what lets the case below say what the OLD branch put on screen.
 */
function renderFinalizedView(readOnly: boolean) {
  const lines = [{ ...invoiceLine }];
  const baseline = { rows: lines.map(line => ({ id: line.id, fields: toLineFields(line) })), context: {} };
  recoveryFixture.view = { mode: "conflict", savedBaseline: baseline, current: undefined,
    reference: undefined, canRestore: false, needsRefresh: false };
  return renderToStaticMarkup(<InvoiceLinesGrid invoiceId="invoice-238" lines={lines} kind="INVOICE"
    recoverySource={{ read: vi.fn(), register: vi.fn(), begin: vi.fn() }}
    moneyGate={{ allowed: false, disabled: true, title: "Invoice is finalized" }}
    applyMutation={async () => {}} readOnly={readOnly} />);
}

function amountInput(html: string) {
  const input = html.match(/<input\b[^>]*aria-label="Line 1 amount"[^>]*>/)?.[0];
  expect(input).toBeDefined();
  return input!;
}

describe("invoice read-only amount formatting (#238)", () => {
  it("formats saved amounts while a retained draft awaits Restore", () => {
    const input = amountInput(renderInvoiceLine("OPERATION", true, 12345.5, true));
    expect(input).toContain('value="$12,345.50"');
    expect(input).toContain('disabled=""');
  });
  it.each(["OPERATION", "CHARGE"] as const)("keeps the enabled %s amount editable as raw decimal text", (kind) => {
    const input = amountInput(renderInvoiceLine(kind, true));
    expect(input).toContain('value="12345.5"');
    expect(input).not.toContain('disabled=""');
  });

  it.each(["PART", "OPERATION", "CHARGE"] as const)("formats the disabled %s amount without changing its data", (kind) => {
    const input = amountInput(renderInvoiceLine(kind, false));
    expect(input).toContain('value="$12,345.50"');
    expect(input).toContain('disabled=""');
    expect(input).toMatch(/class="[^"]*\btabular-nums\b/);
  });

  it("formats a PART amount even when the user may edit money", () => {
    const input = amountInput(renderInvoiceLine("PART", true));
    expect(input).toContain('value="$12,345.50"');
    expect(input).toContain('disabled=""');
  });

  it("shows the real zero-money PART value as currency", () => {
    expect(amountInput(renderInvoiceLine("PART", true, 0))).toContain('value="$0.00"');
  });

  it("retains all four unit-price decimals, and an operation line shows no rate (#638)", () => {
    // The fixture carries a rate the server never writes on an operation line; the operation table
    // has no Rate column, so it shows nowhere (R9; the owner's answers of 2026-11-06).
    const shown = cells(renderInvoiceLine("OPERATION", true), "td").map(text);
    expect(shown).toContain("$1,234.5678");
    expect(shown.filter((c) => c.includes("0.075") || c.includes("7.5%"))).toEqual([]);
  });

  it.each([
    ["a percent surcharge", "SURCHARGE", 0.075, "7.5%"],
    ["the tax line", "TAX", 0.0725, "7.25%"],
    ["a flat surcharge", "SURCHARGE", null, "—"],
    ["a charge", "CHARGE", null, "—"],
  ] as const)("shows %s's rate as a percent in the second table's Rate column (#638)", (_name, kind, rate, shown) => {
    const html = renderInvoiceLine(kind, true, invoiceLine.amount, false, false, { rate });
    const heads = cells(html, "th").map(text);
    expect(cells(html, "td").map(text)[heads.indexOf("Rate")]).toBe(shown);
  });
});


describe("invoice lines on a FINALIZED invoice — the read-only branch (S3, #239)", () => {
  /**
   * The point of the branch is that there is no control to disable: a finalized invoice's lines are
   * frozen paper, the server refuses every edit already, and the grid used to draw them as inputs
   * that merely looked editable. These cases are the OTHER arm of the #238 formatting rule the
   * describe above pins — "disabled invoice amounts may format their raw state at render time;
   * enabled inputs and save payloads stay raw" — at its purest, since nothing here is ever typed
   * into or submitted. The disabled-input cases above are deliberately left alone: a DRAFT invoice
   * whose caller may not change money still renders them, and so does a discarded one.
   */

  it("renders the amount as currency in a plain cell, with no input at all", () => {
    const html = renderFinalizedLine("OPERATION");
    expect(html).not.toMatch(/<input\b/);
    expect(cells(html, "td").map(text)).toContain("$12,345.50");
  });

  it("puts qty, weight and unit price through the shared formatters", () => {
    const shown = cells(renderFinalizedLine("OPERATION"), "td").map(text);
    expect(shown).toContain("1,000");      // formatNumber, counts at 0 places
    expect(shown).toContain("1,000.50");   // formatNumber, weights at 2
    expect(shown).toContain("$1,234.5678");// formatMoney(_, 4), the unit-price precision
  });

  it.each([
    ["a percent surcharge", "SURCHARGE", 0.075, "7.5%"],
    ["the tax line", "TAX", 0.0725, "7.25%"],
    ["a flat surcharge", "SURCHARGE", null, "—"],
  ] as const)("shows %s's frozen rate as a percent, as the editable grid does (#638)", (_name, kind, rate, shown) => {
    const html = renderFinalizedLine(kind, { rate });
    const heads = cells(html, "th").map(text);
    expect(cells(html, "td").map(text)[heads.indexOf("Rate")]).toBe(shown);
  });

  it("shows an em dash for an absent qty, weight and GL account", () => {
    const shown = cells(renderFinalizedLine("OPERATION",
      { qty: null, weight: null, rate: null, glAccountName: "" }), "td").map(text);
    expect(shown.filter(cell => cell === "—")).toHaveLength(3);
  });

  it("renders no Remove, Add charge line, Save or Discard control", () => {
    const html = renderFinalizedLine("OPERATION");
    for (const control of ["Remove", "Add charge line", "Save lines", "Discard"]) {
      expect(`${control}: ${html.includes(control)}`).toBe(`${control}: false`);
    }
    expect(html).not.toMatch(/<button\b/);
  });

  it("says on screen why there is nothing to click", () => {
    // A native `title` is browser chrome: it never reaches a screenshot and never reaches anyone
    // not hovering. And on THIS screen it did not even say the right thing — see the case below.
    expect(text(renderFinalizedLine("OPERATION")))
      .toContain("Finalized — these are the figures this invoice was issued on."); // the owner's words, PR 6
  });

  it("replaces a tooltip that named the wrong reason entirely", () => {
    // What a finalized invoice ACTUALLY rendered before this branch, measured rather than assumed:
    // its draft-store view is "conflict", so `grid.canEdit` is false and every control takes its
    // title from `recoveryGate` — not from the `moneyGate` whose title is "Invoice is finalized".
    // The whole grid read "Resolve draft recovery before editing." on a healthy finalized invoice
    // with no retained draft in the browser at all. That is the sentence this branch deletes.
    const beforeBranch = renderFinalizedView(false);
    const titles = [...beforeBranch.matchAll(/title="([^"]*)"/g)].map(m => m[1]);
    expect(titles.length).toBeGreaterThan(0);
    expect([...new Set(titles)]).toEqual(["Resolve draft recovery before editing."]);
    // The same view through the frozen branch: no control, and so no tooltip, on any element.
    const frozen = renderFinalizedView(true);
    expect(frozen).not.toMatch(/\btitle="/);
    expect(frozen).not.toMatch(/<input\b/);
    // And the draft-store's own notice stays silent on a finalized invoice carrying no retained
    // copy (DraftRecoveryNotice returns null for a bare "conflict"), so this branch is not hiding
    // an amber panel: when there IS a copy, its Discard is the escape hatch and still renders.
    expect(frozen).not.toContain('aria-label="Draft recovery"');
  });

  it("keeps the same data columns, dropping only the Remove column's own header", () => {
    const editable = cells(renderInvoiceLine("OPERATION", true), "th").map(text);
    const frozen = cells(renderFinalizedLine("OPERATION"), "th").map(text);
    expect(editable).toEqual(["Kind", "Description", "Qty", "Net weight (lb)", "Unit price", "GL account", "Amount", "", ""]);
    expect(frozen).toEqual(["Kind", "Description", "Qty", "Net weight (lb)", "Unit price", "GL account", "Amount", ""]);
  });

  it("keeps the needs-price marker, which rides in the header it did NOT drop", () => {
    const html = renderFinalizedLine("OPERATION", { needsPrice: true });
    expect(text(html)).toContain("needs price");
    expect(html).toContain(BADGE_WARNING);
  });

  it("keeps the frozen quote label on an operation line, never a live join", () => {
    const html = renderFinalizedLine("OPERATION", { priceSource: "QUOTE", sourceQuoteNumber: 1006 });
    expect(text(html)).toContain("Quote #1006");
  });

  it("does the same for the surcharge/freight/charge/cert/tax table", () => {
    const html = renderFinalizedLine("CHARGE");
    expect(html).not.toMatch(/<input\b/);
    expect(cells(html, "td").map(text)).toContain("$12,345.50");
    expect(cells(html, "th").map(text)).toEqual(["Kind", "Description", "Rate", "GL account", "Amount", ""]);
  });
});

describe("invoice draft lines: spoken names (the weights design's §11.3, K7 and K8b)", () => {
  it("keeps each box's spoken name under the renamed heading", () => {
    // The heading over the weight box reads "Net weight (lb)". The box's name was written apart
    // from that heading and stays "Line 1 weight" (the owner's answer 4 of 2026-10-10).
    const html = renderInvoiceLine("OPERATION", true);
    expect([...html.matchAll(/<input\b[^>]*\baria-label="([^"]*)"/g)].map((match) => match[1]))
      .toEqual(["Line 1 description", "Line 1 qty", "Line 1 weight", "Line 1 amount"]);
  });
});

describe("invoice lines: the net weight heading's cell (the owner's choices of 2026-10-10)", () => {
  it.each<[where: string, render: () => string]>([
    ["a draft's table", () => renderInvoiceLine("OPERATION", true)],
    ["a finalized invoice's table", () => renderFinalizedLine("OPERATION")],
  ])("%s: the cell carries lg:whitespace-nowrap and no bare whitespace-nowrap", (_where, render) => {
    // The classes of each heading cell that reads "Net weight (lb)". `lg:whitespace-nowrap` is
    // Tailwind's one-line class from its `lg` breakpoint up, 64rem by Tailwind's default, which
    // is 1024 px. A bare `whitespace-nowrap` is the same class at every width, and is refused:
    // the owner's choice on the second look is one line from 1024 px up and wrapping below that.
    const held = cells(render(), "th").filter((th) => text(th) === "Net weight (lb)")
      .map((th) => /^<th class="([^"]*)">/.exec(th)?.[1].split(" ") ?? []);
    expect(held.map((classes) => classes.includes("lg:whitespace-nowrap"))).toEqual([true]);
    expect(held.map((classes) => classes.includes("whitespace-nowrap"))).toEqual([false]);
  });
});

describe("invoice lines: the Save lines title (#487; the owner's answer 7 of 2026-10-16)", () => {
  /** Save lines' opening tag: whether it is closed, and its title. */
  function saveLines(html: string): [boolean, string | undefined] {
    const tags = [...html.matchAll(/(<button\b[^>]*>)Save lines</g)].map((match) => match[1]);
    expect(tags).toHaveLength(1);
    return [/\sdisabled=""/.test(tags[0]), tags[0].match(/\stitle="([^"]*)"/)?.[1]];
  }

  it("a clean draft under an open gate says there is nothing to save", () => {
    expect(saveLines(renderInvoiceLine("OPERATION", true))).toEqual([true, "No unsaved changes"]);
  });

  it("keeps its own recovery sentence while its recovery read is in flight, and while a retained draft is offered", () => {
    // #483 covered the saved shipment page only: the invoice's `recoveryGate` is not `gridGate`.
    recoveryFixture.view = { mode: "loading", canRestore: false, needsRefresh: false };
    const loading = renderToStaticMarkup(<InvoiceLinesGrid invoiceId="invoice-238" lines={[{ ...invoiceLine }]} kind="INVOICE"
      recoverySource={{ read: vi.fn(), register: vi.fn(), begin: vi.fn() }} moneyGate={{ allowed: true, disabled: false, title: undefined }}
      applyMutation={async () => {}} readOnly={false} />);
    expect(saveLines(loading)).toEqual([true, "Resolve draft recovery before editing."]);
    expect(saveLines(renderInvoiceLine("OPERATION", true, invoiceLine.amount, true))).toEqual([true, "Resolve draft recovery before editing."]);
  });

  it.each(["unavailable", "error"] as const)(
    "keeps its own recovery sentence when its recovery read failed (unavailable) or its data was refused (error): %s",
    (mode) => {
      // The owner's answer names the failed read beside the loading one. A failed read puts the
      // grid in `unavailable`: useBulkGrid's read hands the draft store `{ kind: "unavailable" }`
      // when the read rejects (bulk-grid.ts), and the store reports that access as that mode.
      // `error` is the store's `failed`, set where draft-store.ts refuses data: data that fails a
      // validity check, or a clean copy after a discard that is dirty.
      // The invoice's own `recoveryGate` is open only while the grid's mode is `editing`
      // (InvoiceDetail.tsx), so both close it as loading does.
      recoveryFixture.view = { mode, canRestore: false, needsRefresh: false };
      const html = renderToStaticMarkup(<InvoiceLinesGrid invoiceId="invoice-238" lines={[{ ...invoiceLine }]} kind="INVOICE"
        recoverySource={{ read: vi.fn(), register: vi.fn(), begin: vi.fn() }} moneyGate={{ allowed: true, disabled: false, title: undefined }}
        applyMutation={async () => {}} readOnly={false} />);
      expect(saveLines(html)).toEqual([true, "Resolve draft recovery before editing."]);
    },
  );
});

describe("invoice lines while the grid's own Save is in transport (R23, owner ruling 2026-10-22, #702)", () => {
  it("closes every line box and Remove, untitled, shows the amount as typed, and leaves Save lines open and untitled", () => {
    const lines = [{ ...invoiceLine }];
    const baseline = { rows: lines.map(line => ({ id: line.id, fields: toLineFields(line) })), context: {} };
    const data = { ...emptyBulkDraft(), edits: new Map([[invoiceLine.id, { amount: "12345.5" }]]) };
    const stamp = { key: { owner: { userId: "fixture", authGeneration: 1 }, record: { kind: "invoice", id: "invoice-238" }, editor: "invoice-lines" }, generation: 1, version: 2 };
    const html = (pending: boolean) => {
      recoveryFixture.view = { mode: "editing", savedBaseline: baseline, current: { data, baseline, stamp }, canRestore: false, needsRefresh: false,
        ...(pending ? { pending: true } : {}) };
      return renderToStaticMarkup(<InvoiceLinesGrid invoiceId="invoice-238" lines={lines} kind="INVOICE"
        recoverySource={{ read: vi.fn(), register: vi.fn(), begin: vi.fn() }} moneyGate={{ allowed: true, disabled: false, title: undefined }}
        applyMutation={async () => {}} readOnly={false} />);
    };
    const controls = (markup: string) => [
      ...(markup.match(/<input\b[^>]*>/g) ?? []).map(tag => [tag.match(/\saria-label="([^"]*)"/)?.[1] ?? "", tag] as const),
      ...[...markup.matchAll(/(<button\b[^>]*>)(Remove|Add charge)</g)].map(match => [match[2], match[1]] as const),
    ].map(([name, tag]) => [name, /\sdisabled=""/.test(tag), tag.match(/\stitle="([^"]*)"/)?.[1], tag.match(/\svalue="([^"]*)"/)?.[1]]);
    const saving = controls(html(true));
    expect(saving.length).toBeGreaterThan(3);
    expect(saving.filter(([, disabled, title]) => !disabled || title !== undefined)).toEqual([]);
    // The amount is the text as typed, not the read-only figure: closing for a save is not paper.
    expect(saving.map(([, , , value]) => value)).toContain("12345.5");
    const save = [...html(true).matchAll(/(<button\b[^>]*>)Save lines</g)].map(match => match[1]);
    expect(save.map(tag => [/\sdisabled=""/.test(tag), tag.match(/\stitle="([^"]*)"/)?.[1]])).toEqual([[false, undefined]]);
    // The same draft with no save in transport: open again.
    expect(controls(html(false)).filter(([, disabled]) => disabled)).toEqual([]);
  });
});

describe("invoice lines: an operation line's description box offers the part's steps (#587)", () => {
  const ageHarden = { id: "code-ah", code: "AH", name: "Age Harden" };
  const temper = { id: "code-temp", code: "TEMP", name: "Temper" };
  const stepSuggestions: InvoiceStepSuggestions = { byOrderLine: {}, others: [ageHarden, temper] };
  /** The opening tag of the input named `Line 1 description`: there is exactly one. */
  function descriptionBox(html: string) {
    const tags = [...html.matchAll(/<input\b[^>]*\baria-label="Line 1 description"[^>]*>/g)].map((match) => match[0]);
    expect(tags).toHaveLength(1);
    return tags[0];
  }

  it("a draft invoice's OPERATION row: a closed combobox under the box's own name, holding the line's words", () => {
    const box = descriptionBox(renderInvoiceLine("OPERATION", true, invoiceLine.amount, false, false, {}, { stepSuggestions }));
    expect(box).toContain('role="combobox"');
    expect(box).toContain('aria-autocomplete="list"');
    expect(box).toContain('aria-expanded="false"');
    expect(box).toContain('value="Heat treatment"');
    // Closed: it points at no list and no option, and no list is drawn.
    expect(box).not.toContain("aria-controls=");
    expect(box).not.toContain("aria-activedescendant=");
    expect(box).not.toContain('disabled=""');
    expect(renderInvoiceLine("OPERATION", true, invoiceLine.amount, false, false, {}, { stepSuggestions })).not.toContain('role="listbox"');
  });

  it("is a combobox with no list read yet too, and is closed to typing under a closed gate", () => {
    expect(descriptionBox(renderInvoiceLine("OPERATION", true))).toContain('role="combobox"');
    const locked = descriptionBox(renderInvoiceLine("OPERATION", false, invoiceLine.amount, false, false, {}, { stepSuggestions }));
    expect(locked).toContain('role="combobox"');
    expect(locked).toContain('disabled=""');
    expect(locked).toContain('title="Read-only invoice"');
  });

  it.each<[where: string, render: () => string]>([
    ["a credit memo's OPERATION row (587-12)", () => renderInvoiceLine("OPERATION", true, invoiceLine.amount, false, false, {}, { invoiceKind: "CREDIT", stepSuggestions })],
    ["a draft invoice's PART row", () => renderInvoiceLine("PART", true, invoiceLine.amount, false, false, {}, { stepSuggestions })],
    ["a draft invoice's CHARGE row", () => renderInvoiceLine("CHARGE", true, invoiceLine.amount, false, false, {}, { stepSuggestions })],
  ])("%s keeps the plain box", (_where, render) => {
    const html = render();
    expect(descriptionBox(html)).not.toContain("role=");
    expect(html).not.toContain('role="combobox"');
  });

  it("a finalized invoice's lines are paper: no box at all", () => {
    const html = renderFinalizedLine("OPERATION");
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toMatch(/<input\b/);
  });

  it("the list: named Step suggestions, each option reading CODE — Name, the active one selected", () => {
    const html = renderToStaticMarkup(<StepSuggestionList id="steps" options={[ageHarden, temper]} activeIndex={1} onPick={() => {}} />);
    expect(html).toMatch(/^<ul\b[^>]*\brole="listbox"/);
    expect(html).toContain('id="steps"');
    expect(html).toContain('aria-label="Step suggestions"');
    const options = [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)];
    expect(options.map((match) => match[2])).toEqual(["AH — Age Harden", "TEMP — Temper"]);
    expect(options.map((match) => /\brole="option"/.test(match[1]))).toEqual([true, true]);
    expect(options.map((match) => /\bid="([^"]*)"/.exec(match[1])?.[1])).toEqual(["steps-0", "steps-1"]);
    expect(options.map((match) => /\baria-selected="([^"]*)"/.exec(match[1])?.[1])).toEqual(["false", "true"]);
    // No option is selected until an arrow key makes one active: typed words stay the words.
    const none = renderToStaticMarkup(<StepSuggestionList id="steps" options={[ageHarden, temper]} activeIndex={-1} onPick={() => {}} />);
    expect([...none.matchAll(/\baria-selected="([^"]*)"/g)].map((match) => match[1])).toEqual(["false", "false"]);
  });

  it("an option picks on mousedown and keeps the focus in the box (the ProcessCodeSearch precedent)", () => {
    const onPick = vi.fn();
    const list = StepSuggestionList({ id: "steps", options: [ageHarden, temper], activeIndex: -1, onPick });
    const items = list.props.children as { props: { children: { props: { onMouseDown: (e: { preventDefault: () => void }) => void; onClick?: unknown } } } }[];
    const preventDefault = vi.fn();
    items[1].props.children.props.onMouseDown({ preventDefault });
    expect(onPick.mock.calls).toEqual([[temper]]);
    expect(preventDefault).toHaveBeenCalledOnce();
    // Nothing waits for a click, which would come after the box had blurred and closed the list.
    expect(items[1].props.children.props.onClick).toBeUndefined();
  });

  // #587 fix wave (F8): a press on the list itself (its scrollbar, the space between options) keeps
  // the focus in the box too, or the box's blur closes the list under the pointer.
  it("the list's own mousedown keeps the focus in the box, and picks nothing", () => {
    const onPick = vi.fn();
    const list = StepSuggestionList({ id: "steps", options: [ageHarden, temper], activeIndex: -1, onPick });
    const preventDefault = vi.fn();
    (list.props as { onMouseDown: (e: { preventDefault: () => void }) => void }).onMouseDown({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("quote live part summary formatting (#238)", () => {
  it("retains a small each-weight and the part's identity and material", () => {
    const display = { name: "Precision washer", material: "Tool steel", eachWeight: "0.0049" };
    const html = renderToStaticMarkup(<QuotePartSummary display={display} />);
    expect(text(html)).toBe("Precision washer · Tool steel · 0.0049 lb each (live from the part)");
    expect(display.eachWeight).toBe("0.0049");
  });

  it("keeps absent part weight distinct from a zero weight", () => {
    const html = renderToStaticMarkup(<QuotePartSummary display={null} />);
    expect(text(html)).toBe("(live from the part)");
    // The markup too, not only its text: no "lb each", and no "lb ea" that is not the start of it.
    expect(html).not.toContain("lb each");
    expect(html).not.toMatch(/lb ea(?!ch)/);
  });
});
