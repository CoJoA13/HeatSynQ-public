import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OrderLineCard } from "../src/app/orders/new/OrderLineCard";
import type { LineDraft, PartOption } from "../src/app/orders/new/order-draft";
import type { Gate } from "../src/lib/permission-ui";

// #239 items C2a and L4a, both on `/orders/new`'s part line.
//
// C2a: the Part picker has always refused to open before a customer is chosen ("Pick a customer
// first") — every part number in this app belongs to a customer, so there is no catalog to pick
// from yet. Qty, Weight and the serial range box sat beside it fully typeable, so the blank form
// invited work that the first pick would then have had to reconcile: the weight it shows is
// derived from the part's each-weight, and the serials name pieces of a part nobody has named.
//
// L4a: the lead line's revision panel is a grey box whose every branch is conditional on
// `leadCheck`, and `leadCheck` is null until a part is picked — so the blank form drew the box
// with nothing at all inside it.
//
// vitest runs `environment: "node"` and this repo ships no DOM renderer, so these are SSR renders:
// effects never run, which is exactly the state under test for both items (a freshly mounted card
// with no verdict yet). The one thing SSR cannot reach on its own — a card that HAS a verdict — is
// injected through the `useState` seam below, the `new-shipment-recovery.test.tsx` precedent.

/** Substitutes `value` for the Nth (1-based) `useState(null)` call of a render pass. OrderLineCard
 *  takes two — `rangeError` then `leadCheck` — so `leadCheck` is the second, and every case that
 *  uses this ALSO asserts a sentence only the lead panel renders, which is what proves the
 *  substitution landed on the state this comment claims it does rather than on its neighbour. */
const injected = vi.hoisted(() => ({ nth: 0, value: undefined as unknown, seen: 0 }));
vi.mock("react", async original => {
  const real = await original<typeof import("react")>();
  return { ...real, useState: (initial: unknown) => {
    const state = real.useState(initial);
    if (initial !== null || injected.nth === 0) return state;
    return ++injected.seen === injected.nth ? [injected.value, state[1]] : state;
  } };
});

const allowed: Gate = { allowed: true, disabled: false, title: undefined };
const PART: PartOption = {
  id: "part-1", customerId: "cust-1", partNumber: "P-1", name: "Shaft", eachWeight: 2.5,
  serializationRequired: false, hasProcessSteps: true, certRequired: null, certScope: null,
  inheritedCertRequired: false, inheritedCertScope: "ORDER",
};
function draft(over: Partial<LineDraft> = {}): LineDraft {
  return { id: "line-1", partId: null, qty: "", weightOverride: null, serials: [], ...over };
}

function render(over: {
  customerChosen?: boolean; isLead?: boolean; line?: LineDraft; leadCheck?: unknown;
} = {}): string {
  injected.nth = "leadCheck" in over ? 2 : 0;
  injected.value = over.leadCheck;
  injected.seen = 0;
  const customerChosen = over.customerChosen ?? false;
  return renderToStaticMarkup(
    <OrderLineCard index={0} isLead={over.isLead ?? true} line={over.line ?? draft()} parts={[PART]}
                   customerChosen={customerChosen} partsGate={allowed} processesGate={allowed}
                   customerId={customerChosen ? "cust-1" : null} receivedDate={undefined}
                   ordersViewAllowed quotePickGate={allowed} onChange={() => {}} />,
  );
}

/** The rendered `<input>` carrying this exact `aria-label`. */
function field(html: string, label: string): string {
  const tag = (html.match(/<input\b[^>]*>/g) ?? []).find(t => t.includes(`aria-label="${label}"`));
  expect(tag, label).toBeDefined();
  return tag!;
}

const LINE_FIELDS = ["Line 1 quantity", "Line 1 weight", "Line 1 add serial"] as const;

describe("C2a — a part line waits for the customer the whole line belongs to", () => {
  it("disables every typeable field on the line, not only the part picker, before a customer is chosen", () => {
    const html = render({ customerChosen: false });
    // The picker's own long-standing refusal, asserted here so the three below are proved to match
    // it rather than merely to be disabled for some reason of their own.
    expect(html).toContain('aria-label="Line 1 part"');
    expect(html).toContain('title="Pick a customer first"');
    for (const label of LINE_FIELDS) {
      expect(field(html, label), label).toContain('disabled=""');
      expect(field(html, label), label).toContain('title="Pick a customer first"');
    }
  });

  it("releases those same fields once a customer is chosen", () => {
    const html = render({ customerChosen: true });
    for (const label of LINE_FIELDS) {
      expect(field(html, label), label).not.toContain('disabled=""');
      expect(field(html, label), label).not.toContain("Pick a customer first");
    }
  });

  // A rider is gated on the same condition as the lead — `customerChosen` is the customer the
  // whole ORDER is for, not something about line position.
  it("gates a rider line the same way", () => {
    const blank = render({ customerChosen: false, isLead: false });
    for (const label of ["Line 1 quantity", "Line 1 weight", "Line 1 add serial"]) {
      expect(field(blank, label), label).toContain('disabled=""');
    }
    const chosen = render({ customerChosen: true, isLead: false });
    for (const label of ["Line 1 quantity", "Line 1 weight", "Line 1 add serial"]) {
      expect(field(chosen, label), label).not.toContain('disabled=""');
    }
  });
});

describe("L4a — the lead revision panel renders only once there is a verdict to show", () => {
  const STRIP = 'class="mt-3 rounded border border-line bg-surface-50 p-2 text-sm"';

  it("draws no empty strip on a lead line with no verdict yet", () => {
    const html = render({ customerChosen: true, isLead: true });
    // The card itself rendered — the absence below is the panel's, not an empty render's.
    expect(html).toContain('aria-label="Line 1 part"');
    expect(html).not.toContain(STRIP);
  });

  it.each([
    ["checking", { status: "checking" }, "Checking process steps…"],
    ["no-steps", { status: "no-steps" }, "No process steps — this part cannot be the lead."],
    ["unknown", { status: "unknown", message: "offline" }, "Could not verify process steps: offline"],
    ["ok", { status: "ok", revisionNumber: 3, steps: [] }, "Rev 3 — locks at save"],
  ])("draws it, with its sentence, for a %s verdict", (_name, leadCheck, sentence) => {
    const html = render({ customerChosen: true, isLead: true, line: draft({ partId: "part-1" }), leadCheck });
    expect(html).toContain(STRIP);
    expect(html).toContain(sentence);
  });

  // The panel belongs to the lead slot alone (spec §11 — riders never lock a revision), so a
  // verdict reaching a rider card must still draw nothing.
  it("never draws it on a rider, verdict or not", () => {
    const html = render({ customerChosen: true, isLead: false, line: draft({ partId: "part-1" }),
      leadCheck: { status: "ok", revisionNumber: 3, steps: [] } });
    expect(html).not.toContain(STRIP);
    expect(html).not.toContain("locks at save");
  });
});
