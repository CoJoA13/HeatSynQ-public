import { describe, expect, it } from "vitest";
import { invoiceDocumentNumber } from "@/lib/invoice-constants";
import { printedSince, printTickable, selectedPrintRefusal } from "@/lib/invoice-printed";

// #591 (owner rulings 591-1 and 591-2, and "Refuse both", 2026-10-20): the Invoicing list's Printed
// cell is the newest INVOICE or CREDIT print made at or after the row's current `finalizedAt`, a
// draft row shows its newest print, and only a row finalized and not printed since it was finalized
// takes a box, and none on a voided order (owner, 2026-10-21). The selected print refuses a row
// that is not finalized and one printed since in the owner's own sentences. The leaf is pure, so
// each guard below is proven by changing it and watching its case go red.

const FINALIZED_AT = new Date("2026-10-20T14:30:00.123Z");
const before = new Date(FINALIZED_AT.getTime() - 1);
const after = new Date(FINALIZED_AT.getTime() + 1);

describe("printedSince", () => {
  it("is null when the row has never printed, finalized or not", () => {
    expect(printedSince(FINALIZED_AT, null)).toBeNull();
    expect(printedSince(null, null)).toBeNull();
  });

  it("is null when the newest print came before the finalize", () => {
    expect(printedSince(FINALIZED_AT, before)).toBeNull();
  });

  it("is the print when it was made in the very millisecond of the finalize", () => {
    // Two Date objects, one instant: the comparison is of the instant, not the object.
    const sameInstant = new Date(FINALIZED_AT.getTime());
    expect(printedSince(FINALIZED_AT, sameInstant)).toBe(sameInstant);
  });

  it("is the print when it was made after the finalize", () => {
    expect(printedSince(FINALIZED_AT, after)).toBe(after);
  });

  it("is a draft's newest print, whenever it was made", () => {
    expect(printedSince(null, before)).toBe(before);
    expect(printedSince(null, after)).toBe(after);
  });
});

describe("printTickable", () => {
  it("ticks a finalized row that has not printed since it was finalized", () => {
    expect(printTickable({ status: "FINALIZED", printedAt: null, orderVoided: false })).toBe(true);
  });

  it("never ticks a printed row", () => {
    expect(printTickable({ status: "FINALIZED", printedAt: after.toISOString(), orderVoided: false })).toBe(false);
  });

  it("never ticks a draft, printed or not", () => {
    expect(printTickable({ status: "DRAFT", printedAt: null, orderVoided: false })).toBe(false);
    expect(printTickable({ status: "DRAFT", printedAt: after.toISOString(), orderVoided: false })).toBe(false);
  });

  it("never ticks a row on a voided order, whose print the server refuses (owner, 2026-10-21: no box)", () => {
    expect(printTickable({ status: "FINALIZED", printedAt: null, orderVoided: true })).toBe(false);
  });
});

describe("selectedPrintRefusal", () => {
  const prefixed = invoiceDocumentNumber("INVOICE", null, 1001, "7");

  it("refuses a draft invoice in the owner's sentence, the prefix in its number", () => {
    expect(prefixed).toBe("7 - 1001");
    expect(selectedPrintRefusal({ kind: "INVOICE", documentNumber: prefixed, status: "DRAFT", printedAt: null }))
      .toBe("Invoice 7 - 1001 is not finalized, so it was not printed.");
  });

  it("refuses a draft credit memo by its credit number", () => {
    const number = invoiceDocumentNumber("CREDIT", 1000, 1001, "7");
    expect(selectedPrintRefusal({ kind: "CREDIT", documentNumber: number, status: "DRAFT", printedAt: null }))
      .toBe("Credit 1000 is not finalized, so it was not printed.");
  });

  it("asks about the status first: a printed draft is refused as not finalized", () => {
    expect(selectedPrintRefusal({ kind: "INVOICE", documentNumber: "1001", status: "DRAFT", printedAt: after }))
      .toBe("Invoice 1001 is not finalized, so it was not printed.");
  });

  it("refuses an invoice that has already printed since it was finalized", () => {
    expect(selectedPrintRefusal({ kind: "INVOICE", documentNumber: prefixed, status: "FINALIZED", printedAt: after }))
      .toBe("Invoice 7 - 1001 has already printed since it was finalized, so it was not printed again.");
  });

  it("refuses a credit memo that has already printed since it was finalized", () => {
    expect(selectedPrintRefusal({ kind: "CREDIT", documentNumber: "1000", status: "FINALIZED", printedAt: after }))
      .toBe("Credit 1000 has already printed since it was finalized, so it was not printed again.");
  });

  it("refuses nothing for a finalized row not yet printed, invoice or credit", () => {
    expect(selectedPrintRefusal({ kind: "INVOICE", documentNumber: prefixed, status: "FINALIZED", printedAt: null })).toBeNull();
    expect(selectedPrintRefusal({ kind: "CREDIT", documentNumber: "1000", status: "FINALIZED", printedAt: null })).toBeNull();
  });
});
