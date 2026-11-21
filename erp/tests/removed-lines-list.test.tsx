// #594 (owner answer 2026-11-03): the Removed lines list's words, and that it is drawn on a draft
// only. Rendered with real props; the page mount is read from InvoiceDetail.tsx's own source.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RemovedLinesList } from "@/app/invoicing/[id]/RemovedLinesList";
import {
  amountWhenRemoved, readRemovedLines, removedLineLabel, restoredAllMessage, restoredMessage, REMOVED_LINES_NOTE,
} from "@/lib/invoice-removed-lines";

const open = { allowed: true, disabled: false, title: undefined };
const closed = { allowed: false, disabled: true, title: "Invoice is finalized" };
const lines = [
  { identity: "OPERATION:ol:hard", kind: "OPERATION", label: "HT-208 — Harden and temper", amount: 412.5, removedAt: "2026-11-03T12:00:00.000Z" },
  { identity: "SURCHARGE:s1", kind: "SURCHARGE", label: "Small Lot Charge", amount: 25, removedAt: "2026-11-03T12:00:00.000Z" },
];
const render = (props: Partial<Parameters<typeof RemovedLinesList>[0]> = {}) => renderToStaticMarkup(
  <RemovedLinesList invoiceId="inv-1" removedLines={lines} gate={open} applyMutation={async () => {}} {...props} />);

describe("the Removed lines list (#594)", () => {
  it("states the owner's words: heading, note, each line with its amount when removed, and Restore", () => {
    const html = render();
    expect(html).toContain("<h2 class=\"mb-1 font-medium\">Removed lines</h2>");
    expect(html).toContain(REMOVED_LINES_NOTE);
    expect(REMOVED_LINES_NOTE).toBe("Recalculate leaves these out. Restore one and the next Recalculate bills it again.");
    expect(html).toContain("HT-208 — Harden and temper");
    expect(html).toContain("$412.50 when removed");
    expect(html).toContain("$25.00 when removed");
    expect(html.match(/>Restore</g)).toHaveLength(2);
    expect(html).toContain("aria-label=\"Restore Small Lot Charge\"");
    expect(restoredMessage("Small Lot Charge")).toBe("Small Lot Charge comes back at the next Recalculate.");
    expect(amountWhenRemoved(3.1)).toBe("$3.10 when removed");
  });

  it("draws nothing with no removed line, and closes Restore on a closed gate with its reason", () => {
    expect(render({ removedLines: [] })).toBe("");
    const html = render({ gate: closed });
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain("title=\"Invoice is finalized\"");
  });

  // Owner answer 2026-11-04: Restore all, while the list holds two or more lines.
  it("offers Restore all under two or more lines, and not under one", () => {
    const html = render();
    expect(html).toContain("aria-label=\"Restore all removed lines\"");
    expect(html.match(/>Restore all</g)).toHaveLength(1);
    expect(render({ removedLines: [lines[0]] })).not.toContain("Restore all");
    expect(restoredAllMessage(2)).toBe("2 removed lines come back at the next Recalculate.");
    const source = readFileSync("src/app/invoicing/[id]/RemovedLinesList.tsx", "utf8");
    expect(source).toContain("onClick={() => void restore(removedLines)}");
    expect(source).toContain("{ identities: lines.map((l) => l.identity) }");
  });

  it("is mounted on the Lines tab of a draft only", () => {
    const page = readFileSync("src/app/invoicing/[id]/InvoiceDetail.tsx", "utf8");
    expect(page).toContain("{!finalized && !discarded && (\n        <RemovedLinesList invoiceId={id} removedLines={invoice.removedLines} gate={moneyGate} applyMutation={applyMutation} />");
  });

  it("names a line by its part number and words, and reads the stored column entry by entry", () => {
    expect(removedLineLabel({ partNumber: "HT-208", description: "Harden" })).toBe("HT-208 — Harden");
    expect(removedLineLabel({ partNumber: "", description: "Sales tax" })).toBe("Sales tax");
    expect(readRemovedLines(null)).toEqual([]);
    expect(readRemovedLines([lines[0], { identity: "", kind: "TAX" }, 7, lines[1]])).toEqual(lines);
  });
});
