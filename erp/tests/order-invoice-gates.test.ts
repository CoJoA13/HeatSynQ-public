import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { INVOICE_FREEZE, invoiceFreezeSentence } from "@/lib/invoice-freeze";
import { orderInvoiceGates } from "@/lib/order-invoice-gates";
import type { Gate } from "@/lib/permission-ui";
import { declared, jsxTags } from "./helpers/jsx-source";

// The order hub under a finalized invoice (#472, owner ruling R-Q5 of 2026-10-08). The server
// refuses a line change, a line removal (#486), an added line and a charges save there with the
// invoice's sentence, and no other save behind the hub's edit gate asks about the invoice. So the
// page builds two gates from its edit gate: one for the Lines section and one for the Charges
// section. Every other section keeps the edit gate. Void order, which the server refuses there
// too, keeps its own gate by that ruling.
//
// The first half runs the leaf. The second half reads the page as source, because vitest has no
// DOM and nothing renders the hub whole. What a section does with the gate it is handed is its own
// suites' to prove (lines-section-wiring.test.ts, lines-section-offer.test.tsx). This file proves
// which gate the page hands to whom, and where the page learns that the order is invoiced.

const OPEN: Gate = { allowed: true, disabled: false, title: undefined };
const VOIDED: Gate = { allowed: false, disabled: true, title: "Order is voided" };
const NO_PERMISSION: Gate = { allowed: false, disabled: true, title: "Requires orders.edit" };
/** The invoice as the server's sentence names it: by its own id and its order's number. */
const INVOICE = { invoiceId: "inv-1", orderNumber: 1031 };

describe("orderInvoiceGates", () => {
  it("hands back the edit gate itself, twice, when the order has no finalized invoice", () => {
    for (const editGate of [OPEN, VOIDED, NO_PERMISSION]) {
      const { linesGate, chargesGate } = orderInvoiceGates(editGate, 1031, null);
      expect(linesGate).toBe(editGate);
      expect(chargesGate).toBe(editGate);
    }
  });

  it("closes an open edit gate with the sentence each section's own save would be refused with", () => {
    const { linesGate, chargesGate } = orderInvoiceGates(OPEN, 1031, "inv-1");
    expect(linesGate).toEqual({
      allowed: false, disabled: true, title: invoiceFreezeSentence(INVOICE_FREEZE.changeLine, INVOICE),
    });
    expect(chargesGate).toEqual({
      allowed: false, disabled: true, title: invoiceFreezeSentence(INVOICE_FREEZE.changeCharges, INVOICE),
    });
    // Two sections, two sentences: neither borrows the other's.
    expect(linesGate.title).not.toBe(chargesGate.title);
  });

  it("leaves a closed edit gate alone, so a voided order and a missing permission keep their own reason", () => {
    for (const editGate of [VOIDED, NO_PERMISSION]) {
      const { linesGate, chargesGate } = orderInvoiceGates(editGate, 1031, "inv-1");
      expect(linesGate).toBe(editGate);
      expect(chargesGate).toBe(editGate);
    }
  });
});

// ---- the page, read as source ----

const PAGE = "src/app/orders/[id]/page.tsx";
const pageFile = fileURLToPath(new URL(`../${PAGE}`, import.meta.url));
const page = ts.createSourceFile(pageFile, readFileSync(pageFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Every call of the bare identifier `name` under `root`, in source order. */
function callsTo(root: ts.Node, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) out.push(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
  return out;
}
/** How many times the identifier `name` is written under `root`: where it is declared and every
 *  use, a call or not. Parsed, so a comment or a string that spells the name is not counted. */
function mentions(root: ts.Node, name: string): number {
  let count = 0;
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) count += 1;
    ts.forEachChild(node, walk);
  };
  walk(root);
  return count;
}
/** Source text with every run of whitespace removed, so a pin survives re-wrapping. */
const squeezed = (text: string) => text.replace(/\s+/g, "");

describe("the order hub: which gate each section is handed", () => {
  const tags = jsxTags(PAGE);
  const mount = (name: string) => {
    const found = tags.filter((t) => t.name === name);
    expect(found, name).toHaveLength(1);
    return found[0];
  };

  it("Lines is handed the lines gate and Charges the charges gate", () => {
    expect(mount("LinesSection").attr("editGate")).toBe("linesGate");
    expect(mount("ChargesSection").attr("editGate")).toBe("chargesGate");
  });

  it("Containers, Serials and Loads keep the edit gate: the server accepts them under an invoice", () => {
    for (const name of ["ContainersSection", "SerialsSection", "LoadsSection"]) {
      expect(mount(name).attr("editGate"), name).toBe("editGate");
    }
  });

  it("Overview and Notes keep the edit gate: every control the page renders itself reads it, and Link says what it waits for", () => {
    const own = tags.filter((t) => ["input", "select", "textarea", "button"].includes(t.name));
    // PO number, VS order #, Customer job #, the three dates, Certification required and its
    // scope, Unlink, the Link box and its button, Order notes.
    expect(own).toHaveLength(12);
    const isLink = (t: (typeof own)[number]) => t.attr("onClick") === "() => void linkAction()";
    expect(own.filter(isLink)).toHaveLength(1);
    for (const control of own) {
      // The edit gate's reason, and on Link, with the gate open, "Enter an order # first" while no
      // order number is typed (#487, owner answer 2): a box holding only white space is empty.
      expect(control.attr("title"), control.text).toBe(isLink(control)
        ? "waitingTitle(editGate, linkInput.trim() === \"\", ENTER_ORDER_NUMBER_FIRST)" : "editGate.title");
      // A text box closes with readOnly and every other control with disabled. Both read the edit gate.
      expect(control.attr("readOnly") ?? control.attr("disabled"), control.text)
        .toMatch(/^(!editGate\.allowed|editGate\.disabled)( \|\| |$)/);
    }
  });

  it("Void order is not gated by the invoice: the title-row danger button reads the void gate, built as before", () => {
    expect(mount("DangerButton").attr("disabled")).toBe("voidGate.disabled");
    expect(declared(PAGE, "voidGate").map(squeezed)).toEqual([
      'order?.voided?{allowed:false,disabled:true,title:"Alreadyvoided"}:gateDo(perms,"void_order")',
    ]);
  });

  it("both gates come from one call: the edit gate, the order's number and the invoice id the page last read", () => {
    const calls = callsTo(page, "orderInvoiceGates");
    expect(calls).toHaveLength(1);
    expect(squeezed(calls[0].getText(page))).toBe("orderInvoiceGates(editGate,order?.orderNumber??0,finalizedInvoiceId)");
    const into = calls[0].parent;
    expect(ts.isVariableDeclaration(into) && squeezed(into.name.getText(page))).toBe("{linesGate,chargesGate}");
    // The edit gate that goes in knows nothing of invoices: voided first, then the permission.
    expect(declared(PAGE, "editGate").map(squeezed)).toEqual(['voidLocked(gate(perms,"orders.edit"),order?.voided??false)']);
  });

  it("the invoice id is set by a full read of the order, in its accept branch, and by nothing else", () => {
    const sets = callsTo(page, "setFinalizedInvoiceId");
    expect(sets.map((c) => c.getText(page))).toEqual(["setFinalizedInvoiceId(o.finalizedInvoiceId)"]);
    // The setter is written twice in the whole file: where it is declared, and in that one call.
    // So it is handed on to nothing by reference (a child's prop, a `.then`). A search for calls
    // does not see a writer of that kind.
    expect(mentions(page, "setFinalizedInvoiceId")).toBe(2);
    // The call is a statement of the block `if (mutations.accept(ticket))` guards. A read that a
    // newer read or a newer save has overtaken sets neither the order nor the id.
    const block = sets[0].parent.parent;
    const branch = block.parent;
    expect(ts.isIfStatement(branch) && branch.expression.getText(page)).toBe("mutations.accept(ticket)");
    // The block that `if` runs when the read is accepted, and not its `else`: there the id would be
    // set by exactly the reads that were overtaken.
    expect(ts.isIfStatement(branch) && branch.thenStatement === block).toBe(true);
    // That block is `load`'s, and `load` reads the wider type from the one route that carries the id.
    const load = declared(PAGE, "load");
    expect(load).toHaveLength(1);
    expect(load[0]).toContain("api<OrderRead>(`/api/orders/${id}`)");
    expect(load[0]).toContain("setOrder((prev) => captured.merge(prev, keepTravelerPrinted(prev, o)));");
    expect(load[0]).toContain("setFinalizedInvoiceId(o.finalizedInvoiceId);");
    // A mutation response does not carry the id, and applying one never sets it. Nothing more is
    // asserted for that here: the one call and the two mentions above already rule out a second
    // writer anywhere in the file, `applyMutation` included.
  });
});
