import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LinesSection } from "@/app/orders/[id]/LinesSection";
import { fieldKey, type FieldSave, type FieldSaves } from "@/lib/line-field-saves";
import { REMOVAL_NOT_CONFIRMED, removalReason } from "@/lib/line-removals";
import { orderInvoiceGates } from "@/lib/order-invoice-gates";
import type { Gate } from "@/lib/permission-ui";
import type { OrderLine } from "../src/app/orders/[id]/page";
import { headingRowsOf, labelOf } from "./helpers/markup";

// The offered weight on the order hub's Lines section (the quantity corrections design §4), as the
// section renders it. vitest runs in "node" with no DOM renderer, so these are static renders:
// effects never run and no handler fires. What a static render cannot reach on its own, a section
// that already HOLDS state, is injected through the `useState` seam below (the
// order-entry-line-gating.test.tsx precedent). How the state gets there (a quantity save landing
// marks its line, a weight save landing unmarks it) is proven on the section's own `commit` in
// lines-section-wiring.test.ts. The last three blocks are not about the offer. One uses the same
// seam to prove, on what the section renders, that no edit gate disables Restore. One holds the
// words over the section's boxes: the table's heading row and the Add rider strip's labels. The
// last shows a line whose Remove the server did not answer (#475).

/** Substitutes the section's three pieces of state for one render. Two `useState` calls in the
 *  rendered tree start as a Set, both the section's: the record of unconfirmed removals starts as
 *  the leaf's own empty Set, `NO_UNCONFIRMED_REMOVALS`, and is told apart by that identity;
 *  `offerLines` is the other. `saves` is the only one that starts as a Map. Every case that seeds one also asserts something only that
 *  state can put on screen (a figure under a marked line, the seeded text in a box, the reason for
 *  a removal), which is what proves the substitution landed where this comment says it does; and a
 *  case seeding `offerLines` alone shows no removal, which proves the two Sets are kept apart. */
const seeded = vi.hoisted(() => ({
  offerLines: null as ReadonlySet<string> | null, saves: null as unknown, removals: null as ReadonlySet<string> | null,
}));
vi.mock("react", async original => {
  const real = await original<typeof import("react")>();
  const { NO_UNCONFIRMED_REMOVALS } = await import("@/lib/line-removals");
  return { ...real, useState: (initial: unknown) => {
    const state = real.useState(initial);
    if (initial === NO_UNCONFIRMED_REMOVALS) return seeded.removals !== null ? [seeded.removals, state[1]] : state;
    if (initial instanceof Set && seeded.offerLines !== null) return [seeded.offerLines, state[1]];
    if (initial instanceof Map && seeded.saves !== null) return [seeded.saves, state[1]];
    return state;
  } };
});

const allowed: Gate = { allowed: true, disabled: false, title: undefined };
const voided: Gate = { allowed: false, disabled: true, title: "Order is voided" };

function line(over: Partial<OrderLine> & { eachWeight?: number } = {}): OrderLine {
  const { eachWeight = 1.5, ...rest } = over;
  return {
    id: "L1", position: 1, partId: "part-a", revisionNumber: 1, qty: 32, weight: 498,
    quoteLineId: null, quoteId: null, quoteNumber: null,
    part: { id: "part-a", partNumber: "P-A", name: "Shaft", customer: { code: "ACME" }, serializationRequired: false, eachWeight },
    ...rest,
  };
}
/** 32 pieces at 1.5 lb each over a stored 498 lb: the owner's case. The figure is 48 lb. */
const LEAD = line();
/** 10 pieces at 2 lb each over a stored 99 lb. The figure is 20 lb. */
const RIDER = line({ id: "L2", position: 2, partId: "part-b", revisionNumber: null, qty: 10, weight: 99, eachWeight: 2 });

function render(over: {
  lines?: OrderLine[]; offerLines?: string[]; saves?: Record<string, FieldSave>;
  shipped?: Record<string, number>; editGate?: Gate; removals?: string[];
} = {}): string {
  seeded.offerLines = over.offerLines ? new Set(over.offerLines) : null;
  seeded.saves = over.saves ? (new Map(Object.entries(over.saves)) satisfies FieldSaves) : null;
  seeded.removals = over.removals ? new Set(over.removals) : null;
  try {
    return renderToStaticMarkup(
      <LinesSection orderId="order-a" lines={over.lines ?? [LEAD, RIDER]}
                    shippedWeightByLineId={new Map(Object.entries(over.shipped ?? {}))}
                    customerParts={[]} editGate={over.editGate ?? allowed} partsGate={allowed}
                    customerId="cust-1" receivedDate="2026-10-01" ordersViewAllowed
                    applyMutation={async () => {}} readAfterRemoval={async () => {}} />,
    );
  } finally {
    seeded.offerLines = null;
    seeded.saves = null;
    seeded.removals = null;
  }
}
/** Every `<tr>…</tr>` of the lines table's body, in order. */
function bodyRows(html: string): string[] {
  const body = /<tbody>(.*?)<\/tbody>/.exec(html);
  expect(body).not.toBeNull();
  return body![1].match(/<tr\b.*?<\/tr>/g) ?? [];
}
/** The `<button …>` opening tag of the control with this exact text. */
function control(html: string, text: string): string {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`<button\\b[^>]*>${escaped}</button>`).exec(html);
  expect(found, text).not.toBeNull();
  return found![0];
}

describe("LinesSection: the offered weight", () => {
  it("offers nothing at first render, whatever the stored weights are", () => {
    // Both stored weights differ from quantity × each weight. No quantity was saved in this visit,
    // so neither line is offered a figure: a stored weight may be a deliberate received weight.
    const html = render();
    expect(html).not.toContain(" lb = ");
    expect(html).not.toMatch(/>Use [^<]*</);
    expect(bodyRows(html)).toHaveLength(2);
  });

  it("offers the figure under a marked line, and nothing under a line that is not marked", () => {
    const rows = bodyRows(render({ offerLines: ["L1"] }));
    // Lead row, its detail row, the rider's row. The rider's 10 × 2 lb = 20 lb differs from its
    // stored 99 lb too, and it is offered nothing.
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('aria-label="Lead quantity"');
    expect(rows[1]).toContain(">32 × 1.5000 lb = 48.00 lb</span>");
    expect(rows[1]).toContain(">Use 48.00 lb</button>");
    expect(rows[2]).toContain('aria-label="Line 2 quantity"');
    expect(rows.join("")).not.toContain("10 × 2.0000 lb");
  });

  it("offers each marked line its own figure, under its own row", () => {
    const rows = bodyRows(render({ offerLines: ["L1", "L2"] }));
    expect(rows).toHaveLength(4);
    expect(rows[1]).toContain(">32 × 1.5000 lb = 48.00 lb</span>");
    expect(rows[3]).toContain(">10 × 2.0000 lb = 20.00 lb</span>");
    expect(rows[3]).toContain(">Use 20.00 lb</button>");
  });

  it("renders no detail row for a marked line whose stored weight already is the figure", () => {
    // Both lines are marked. The lead's stored 48 lb is its figure; the rider's 99 lb is not.
    const rows = bodyRows(render({ lines: [line({ weight: 48 }), RIDER], offerLines: ["L1", "L2"] }));
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('aria-label="Line 2 quantity"');
    expect(rows[2]).toContain(">10 × 2.0000 lb = 20.00 lb</span>");
    expect(rows.join("")).not.toContain("32 × 1.5000 lb");
  });

  it("ignores a mark for a line the order no longer has", () => {
    const rows = bodyRows(render({ offerLines: ["gone", "L2"] }));
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain(">Use 20.00 lb</button>");
  });

  it("the control is enabled, with no title, for someone who may edit", () => {
    const button = control(render({ offerLines: ["L1"] }), "Use 48.00 lb");
    expect(button).not.toContain(' disabled=""');
    expect(button).not.toContain("title=");
  });

  it("a figure below the weight already shipped is shown, blocked, with the reason", () => {
    const html = render({ offerLines: ["L1"], shipped: { L1: 95 } });
    const button = control(html, "Use 48.00 lb");
    expect(button).toContain(' disabled=""');
    expect(button).toContain('title="Below the 95.00 lb already shipped"');
    expect(bodyRows(html)[1]).toContain(">Below the 95.00 lb already shipped</span>");
    // Another line's shipped weight says nothing about this one.
    const other = control(render({ offerLines: ["L1"], shipped: { L2: 95 } }), "Use 48.00 lb");
    expect(other).not.toContain(' disabled=""');
  });

  it("a figure equal to the weight already shipped can be used", () => {
    const button = control(render({ offerLines: ["L1"], shipped: { L1: 48 } }), "Use 48.00 lb");
    expect(button).not.toContain(' disabled=""');
  });

  it("a closed edit gate disables the control, with the gate's own reason", () => {
    const button = control(render({ offerLines: ["L1"], editGate: voided }), "Use 48.00 lb");
    expect(button).toContain(' disabled=""');
    expect(button).toContain('title="Order is voided"');
  });

  it("the control waits while that line's weight save is out, and says so", () => {
    const saving: FieldSave = { draft: "55", pending: { attempt: 1, text: "55" }, outcome: null };
    const html = render({ offerLines: ["L1"], saves: { [fieldKey("L1", "weight")]: saving } });
    expect(html).toContain('value="55"'); // the seeded save state is the one the weight box reads
    const button = control(html, "Use 48.00 lb");
    expect(button).toContain(' disabled=""');
    expect(button).toContain('title="Wait for this save to finish before using this weight"');
  });

  it("a closed edit gate's reason is the one shown while a save is also out", () => {
    const saving: FieldSave = { draft: "55", pending: { attempt: 1, text: "55" }, outcome: null };
    const html = render({ offerLines: ["L1"], editGate: voided, saves: { [fieldKey("L1", "weight")]: saving } });
    expect(html).toContain('value="55"');
    expect(control(html, "Use 48.00 lb")).toContain('title="Order is voided"');
  });

  it("the control waits while that line's quantity save is out, and says so", () => {
    // The figure on screen is for the 32 pieces the order holds. A quantity save in flight is about
    // to change that number, so the figure is not to be accepted until the save has ended.
    const saving: FieldSave = { draft: "40", pending: { attempt: 1, text: "40" }, outcome: null };
    const html = render({ offerLines: ["L1"], saves: { [fieldKey("L1", "qty")]: saving } });
    expect(html).toContain('value="40"'); // the seeded save state is the one the quantity box reads
    const button = control(html, "Use 48.00 lb");
    expect(button).toContain(' disabled=""');
    expect(button).toContain('title="Wait for this save to finish before using this weight"');
  });

  it("the control does not wait for another line's save", () => {
    const saving: FieldSave = { draft: "40", pending: { attempt: 1, text: "40" }, outcome: null };
    for (const key of [fieldKey("L2", "qty"), fieldKey("L2", "weight")]) {
      const html = render({ offerLines: ["L1"], saves: { [key]: saving } });
      expect(html).toContain('value="40"');
      const button = control(html, "Use 48.00 lb");
      expect(button).not.toContain(' disabled=""');
      expect(button).not.toContain("title=");
    }
  });

  it("the figure follows the stored quantity, not text still in the box", () => {
    // 40 is typed and not saved; the order still holds 32 pieces.
    const typing: FieldSave = { draft: "40", pending: null, outcome: null };
    const html = render({ offerLines: ["L1"], saves: { [fieldKey("L1", "qty")]: typing } });
    expect(html).toContain('value="40"');
    expect(bodyRows(html)[1]).toContain(">32 × 1.5000 lb = 48.00 lb</span>");
  });

  it("is judged against the stored weight, not text still in the weight box", () => {
    // 48 is typed into the weight box and not saved; the order still holds 498 lb.
    const typing: FieldSave = { draft: "48", pending: null, outcome: null };
    const html = render({ offerLines: ["L1"], saves: { [fieldKey("L1", "weight")]: typing } });
    expect(html).toContain('value="48"');
    expect(bodyRows(html)[1]).toContain(">Use 48.00 lb</button>");
  });

  it("sits in the same detail row as a Not saved message, after it", () => {
    const refused: FieldSave = { draft: "5", pending: null, outcome: { kind: "failed", message: "Lead (ACME · P-A): cannot reduce net weight below 10 lb already shipped" } };
    const rows = bodyRows(render({ offerLines: ["L1"], saves: { [fieldKey("L1", "weight")]: refused } }));
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatch(/cannot reduce net weight below 10 lb already shipped<\/p><p[^>]*><span[^>]*>32 × 1\.5000 lb = 48\.00 lb<\/span>/);
  });
});

// No permission or void gate may disable Restore: a refused value on an order that has since
// been voided must still be clearable, or the page holds unsaved work that nothing on it can
// clear. After a refusal, which is what these cases seed, Restore sends nothing. Where it does
// send, while the box records a save the server did not answer, the server refuses a voided order
// or a caller without orders.edit and the box stays Not saved; no gate here would change that.
// line-field-status.test.tsx proves `FieldMark` reads no gate under the prop names it tries; this
// proves it on what the section renders, whatever a gate would be called on its way from the
// section to the button.
describe("LinesSection: a Not saved value under a closed edit gate", () => {
  /** The opening tag of the input with this accessible name. */
  function box(html: string, label: string): string {
    const found = new RegExp(`<input\\b[^>]*aria-label="${label}"[^>]*>`).exec(html);
    expect(found, label).not.toBeNull();
    return found![0];
  }
  const refusedQty: FieldSave = {
    draft: "20", pending: null, outcome: { kind: "failed", message: "Lead (ACME · P-A): cannot reduce qty below 30 already shipped" },
  };
  const refusedWeight: FieldSave = {
    draft: "5", pending: null, outcome: { kind: "failed", message: "Lead (ACME · P-A): cannot reduce net weight below 10 lb already shipped" },
  };

  it.each([
    ["quantity", "qty", refusedQty, "20", "Restore 32"],
    ["weight", "weight", refusedWeight, "5", "Restore 498"],
  ] as const)("the %s box is disabled, and its Restore is not", (labelled, field, refused, typedText, restoreText) => {
    const html = render({ editGate: voided, saves: { [fieldKey("L1", field)]: refused } });
    const input = box(html, `Lead ${labelled}`);
    expect(input).toContain(`value="${typedText}"`); // the seeded save state is the one this box reads
    expect(input).toContain(' disabled=""');
    expect(input).toContain('title="Order is voided"');
    expect(html).toContain(`aria-label="Lead ${labelled} not saved"`);
    const restore = control(html, restoreText);
    expect(restore).not.toContain(' disabled=""');
    expect(restore).not.toContain("title=");
  });

  it("the edit gate changes nothing about Restore; that box's own save in flight is what disables it", () => {
    // The same render with the gate open and with it closed: the button's tag is the same text.
    const open = control(render({ saves: { [fieldKey("L1", "qty")]: refusedQty } }), "Restore 32");
    const closed = control(render({ editGate: voided, saves: { [fieldKey("L1", "qty")]: refusedQty } }), "Restore 32");
    expect(closed).toBe(open);
    // A retry in flight is the one thing that disables it, gate open or closed.
    const retrying: FieldSave = { ...refusedQty, pending: { attempt: 2, text: "20" } };
    for (const editGate of [allowed, voided]) {
      const waiting = control(render({ editGate, saves: { [fieldKey("L1", "qty")]: retrying } }), "Restore 32");
      expect(waiting).toContain(' disabled=""');
      expect(waiting).toContain('title="Wait for this save to finish before restoring"');
    }
  });
});

// The words over the section's boxes (the weights design §11.3, O7 and O8). Each is compared whole,
// so "Weight", the heading and the label before 2026-10-10, is neither this row nor this label.
describe("LinesSection: the heading row and the Add rider labels", () => {
  it("heads the lines table: Part, Qty, Net weight (lb), Quote", () => {
    // One table, so one heading row. Its first and last cells hold no words.
    expect(headingRowsOf(render())).toEqual([["", "Part", "Qty", "Net weight (lb)", "Quote", ""]]);
  });

  it("labels the Add rider boxes Qty and Net weight (lb), each box under the name it is found by", () => {
    const html = render();
    // `labelOf` throws unless exactly one label holds a control of that spoken name, so each line
    // also holds the box's spoken name as it is.
    expect(labelOf(html, "Add rider quantity")).toBe("Qty");
    expect(labelOf(html, "Add rider weight")).toBe("Net weight (lb)");
  });
});

// A line Remove the server did not answer (#475, owner ruling 2026-10-15): the line stays on the
// page, marked beside its Remove, with the reason in its detail row. Remove stays the retry, so the
// mark closes nothing; only the edit gate does, as for every line.
describe("LinesSection: a removal the server did not answer", () => {
  const REASON = removalReason("Line 2");
  /** The `<button …>` opening tag of a row's Remove control. */
  function remove(row: string): string {
    const found = /<button\b[^>]*>Remove<\/button>/.exec(row);
    expect(found, row).not.toBeNull();
    return found![0];
  }
  /** The opening tag of the input with this accessible name. */
  function box(row: string, label: string): string {
    const found = new RegExp(`<input\\b[^>]*aria-label="${label}"[^>]*>`).exec(row);
    expect(found, label).not.toBeNull();
    return found![0];
  }

  it("marks the line beside Remove, says why in its detail row, and leaves Remove and the boxes open", () => {
    const rows = bodyRows(render({ removals: ["L2"] }));
    // The lead's row, the rider's row, the rider's detail row.
    expect(rows).toHaveLength(3);
    expect(rows[0]).not.toContain(REMOVAL_NOT_CONFIRMED);
    expect(rows[1]).toContain(`<span role="alert" aria-label="Line 2 removal not confirmed" class="ml-2 text-xs font-medium text-red-700">${REMOVAL_NOT_CONFIRMED}</span>`);
    expect(rows[2]).toContain(`<p id="line-L2-removal-message" class="text-red-700">${REASON}</p>`);
    const button = remove(rows[1]);
    expect(button).not.toContain(' disabled=""');
    expect(button).not.toContain("title=");
    expect(button).toContain('aria-describedby="line-L2-removal-message"');
    for (const labelled of ["quantity", "weight"]) expect(box(rows[1], `Line 2 ${labelled}`)).not.toContain(' disabled=""');
  });

  it("puts the reason first in a detail row the line's boxes also write", () => {
    const refused: FieldSave = { draft: "4", pending: null, outcome: { kind: "failed", message: "Line 2 (ACME · P-A): cannot reduce qty below 5 already shipped" } };
    const rows = bodyRows(render({ removals: ["L2"], saves: { [fieldKey("L2", "qty")]: refused } }));
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatch(new RegExp(`<p id="line-L2-removal-message"[^>]*>${REASON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p><p id="line-L2-qty-message"`));
  });

  it("under a finalized invoice Remove is closed with the gate's sentence, and the mark and the reason still show", () => {
    const invoiced = orderInvoiceGates(allowed, 1031, "inv-1").linesGate;
    const rows = bodyRows(render({ removals: ["L2"], editGate: invoiced }));
    expect(rows).toHaveLength(3);
    const button = remove(rows[1]);
    expect(button).toContain(' disabled=""');
    expect(button).toContain(`title="${invoiced.title}"`);
    expect(rows[1]).toContain(`>${REMOVAL_NOT_CONFIRMED}</span>`);
    expect(rows[2]).toContain(REASON);
  });

  it("shows nothing for a line that is not marked, or a mark on a line the order no longer lists", () => {
    for (const removals of [undefined, ["gone"]]) {
      const html = render({ removals });
      expect(bodyRows(html)).toHaveLength(2);
      expect(html).not.toContain(REMOVAL_NOT_CONFIRMED);
      expect(html).not.toContain("could not tell whether the removal went through");
      expect(remove(bodyRows(html)[1])).not.toContain("aria-describedby");
    }
  });

  it("an offered line alone is not a marked removal: the two Sets are seeded apart", () => {
    const html = render({ offerLines: ["L2"] });
    expect(bodyRows(html)[2]).toContain(">Use 20.00 lb</button>"); // the offerLines seam landed
    expect(html).not.toContain(REMOVAL_NOT_CONFIRMED);
    expect(html).not.toContain("could not tell whether the removal went through");
  });
});
