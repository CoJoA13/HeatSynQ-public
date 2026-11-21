import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { code, declared, firstTryBlock, identifiers, jsxTags, jsxTexts, mentions, renderedFrom, type JsxTag } from "./helpers/jsx-source";

// Which gate each control of the saved shipment page reads (#472), the early return that holds the
// page until its permission read is in (#483), and where the page takes the ship-to address each
// shipment answer carries, what its Ship-to select and "Ships to:" line read, and the text beside
// that select without customers.view (#484). No vitest test renders ShipmentDetail.tsx whole, so
// this reads its source through the parser, the way tests/lines-section-wiring.test.ts reads the
// order hub's Lines section. What each gate DECIDES is proven in the leaves' own suites
// (tests/shipment-gates.test.ts); this file proves the page asks.
//
// One `describe` per task of the 2026-10-08 plan, one for #483's early return, and one for #484's
// ship-to address. A later task that replaces an expression an earlier case pins rewrites that case
// in the same commit.

const SD = "src/app/shipping/[id]/ShipmentDetail.tsx";
const tags = jsxTags(SD);

/** An expression as one line: every run of whitespace collapsed, so a pin survives re-wrapping. */
const oneLine = (source: string | undefined) => source?.replace(/\s+/g, " ").trim();

/** The one tag `pick` selects. Fails, naming `what`, when there is none or more than one. */
function only(what: string, pick: (tag: JsxTag) => boolean): JsxTag {
  const found = tags.filter(pick);
  expect(found.map((tag) => tag.text), what).toHaveLength(1);
  return found[0];
}

/**
 * Every header field, in source order, as `[field, the attribute that locks it, that attribute's
 * expression, its title's expression]`. A header field is an input, select or textarea whose
 * `onChange` writes one field of the shipment: straight to the server through `patchHeader`, or
 * into local state ahead of a save on blur.
 */
function headerFields(): (string | undefined)[][] {
  return tags
    .filter((tag) => ["input", "select", "textarea"].includes(tag.name))
    .map((tag) => ({
      tag, field: /(?:patchHeader\(\{|patchDraft\(\{) (\w+):/.exec(tag.attr("onChange") ?? "")?.[1],
    }))
    .filter(({ field }) => field !== undefined)
    .map(({ tag, field }) => [
      field, tag.attr("disabled") !== undefined ? "disabled" : "readOnly",
      tag.attr("disabled") ?? tag.attr("readOnly"), tag.attr("title"),
    ]);
}

describe("ShipmentDetail wiring, Task 2: the finalized-invoice freeze", () => {
  it("builds the lines gate and the freight gate from the leaf", () => {
    expect(declared(SD, "linesAddGate")).toEqual(["shipmentLinesGate(extendGate, shipper?.invoicedOrders ?? [])"]);
    expect(declared(SD, "freightGate")).toEqual(["shipmentFreightGate(editGate, shipper?.invoicedOrders ?? [])"]);
  });

  it("nothing reads `extendGate`, the gate without the invoice rung, but the lines gate built from it", () => {
    // Written twice in the whole file: where it is declared, and as the argument the case above
    // pins. A control's attribute, a handler's guard or a binding derived from it would be a third.
    expect(mentions(SD, "extendGate")).toBe(2);
  });

  it("Bill freight and Freight amount read the freight gate, and every other header field the edit gate", () => {
    expect(headerFields()).toEqual([
      ["shipToAddressId", "disabled", "!editGate.allowed", "editGate.title"],
      ["shipDate", "disabled", "!editGate.allowed", "editGate.title"],
      ["carrierId", "disabled", "!editGate.allowed", "editGate.title"],
      ["route", "readOnly", "!editGate.allowed", "editGate.title"],
      ["comments", "readOnly", "!editGate.allowed", "editGate.title"],
      ["billFreight", "disabled", "!freightGate.allowed", "freightGate.title"],
      ["freightAmount", "readOnly", "!freightGate.allowed", "freightGate.title"],
      ["freightTerms", "disabled", "!editGate.allowed", "editGate.title"],
      ["freightClass", "readOnly", "!editGate.allowed", "editGate.title"],
      ["freightDescription", "readOnly", "!editGate.allowed", "editGate.title"],
      ["packageCount", "readOnly", "!editGate.allowed",
        'editGate.allowed ? "Blank uses the current container count" : editGate.title'],
      ["proNumber", "readOnly", "!editGate.allowed", "editGate.title"],
      ["scacCode", "readOnly", "!editGate.allowed", "editGate.title"],
    ]);
  });

  it("each order panel gets the lines gate for its Lines grid and the edit gate for the rest", () => {
    const panel = only("the order panel", (tag) => tag.name === "ShipmentOrderPanel");
    expect(panel.attr("linesGate")).toBe("linesAddGate");
    expect(panel.attr("editGate")).toBe("editGate");
  });

  it("the amber line shows for the invoice the leaf names, with no second condition written beside it", () => {
    expect(declared(SD, "notice")).toEqual(["invoiceNotice(shipper)"]);
    expect(only("the amber line", (tag) => tag.name === "InvoiceFreezeNotice").attr("invoice")).toBe("notice");
    // Its one condition is that the leaf named an invoice. A second condition written beside it
    // would hide the line for a reason the leaf does not hold. That is as far as this reads
    // (`renderedFrom`): a condition on an element that encloses the line, and where the line sits
    // among the page's banners, are not pinned here.
    expect(renderedFrom(SD, "InvoiceFreezeNotice")).toEqual([
      "notice !== null && <InvoiceFreezeNotice invoice={notice} />",
    ]);
  });

  it("Reverse, Void and both prints read the gates they read before", () => {
    expect(only("Reverse", (tag) => tag.name === "ReverseShipmentButton").attr("gate")).toBe("reverseControlGate");
    expect(declared(SD, "reverseControlGate").map(oneLine)).toEqual([
      "shipper === null ? { allowed: false, disabled: true, title: undefined } : reverseGate(perms, shipper)",
    ]);
    const voidButton = only("Void", (tag) => tag.name === "DangerButton" && tag.attr("onClick") === "() => void voidAction()");
    expect([voidButton.attr("disabled"), voidButton.attr("title")]).toEqual(["voidGate.disabled", "voidGate.title"]);
    const prints = tags.filter((tag) =>
      tag.name === "button" && /^\(\) => void print(?:Ticket|Bol)\(/.test(tag.attr("onClick") ?? ""));
    expect(prints.map((tag) => [tag.attr("disabled"), tag.attr("title")])).toEqual([
      ["!printGate.allowed || printing", "printGate.title"],
      ["!printGate.allowed || printing", "printGate.title"],
    ]);
  });
});

describe("ShipmentDetail wiring, Task 3: what has printed, and Remove order's refusal", () => {
  const source = readFileSync(fileURLToPath(new URL(`../${SD}`, import.meta.url)), "utf8");
  /** The one declaration of `name`, as written. */
  const written = (name: string): string => {
    const found = declared(SD, name);
    expect(found, name).toHaveLength(1);
    return found[0];
  };
  const MERGE = code("setPrintedOrders((seen) => mergePrinted(seen, res.printed))");

  it("starts with nothing printed", () => {
    expect(source).toContain("const [printedOrders, setPrintedOrders] = useState<PrintedOrders>(NOTHING_PRINTED);");
  });

  it("merges each shipment answer the page adopts into what has printed: three sites, and none that assigns", () => {
    // The set only grows. An assignment would let a late answer that knows less re-open Remove order.
    for (const name of ["load", "applyMutation", "printDoc"]) expect(code(written(name)), name).toContain(MERGE);
    expect(source.split("setPrintedOrders(").length - 1).toBe(3);
    // The setter is written four times in the whole file: where it is declared, and in those three
    // calls. A fifth would be a writer the count above cannot see, because it is not a call: the
    // setter handed on by reference (`.then(setPrintedOrders)`) assigns whatever it is given.
    expect(mentions(SD, "setPrintedOrders")).toBe(4);
  });

  it("reads the shipment once more after a print, adopts only what has printed, and never runs the page's full read", () => {
    const printDoc = written("printDoc");
    const reread = code("void api<ShipperMutationResult>(`/api/shippers/${id}`).then((res) => " +
      "setPrintedOrders((seen) => mergePrinted(seen, res.printed))).catch(() => {});");
    // The last two statements of the print's own `try` block, written directly in it: the
    // Documents list is told to refresh, then the read. A print that failed has thrown out of
    // that block by then, so only a print that succeeded reads again. In `finally` it would read
    // after a failed print too.
    expect(firstTryBlock(printDoc).slice(-2)).toEqual([code("setDocsRefresh((n) => n + 1);"), reread]);
    // No ticket, no full read and nothing else adopted: none of these names is written in the
    // function at all, called or handed on uncalled (`.then(load)`).
    const names = identifiers(printDoc);
    expect(names).toContain("mergePrinted");
    for (const absent of ["load", "mutations", "setShipper", "setWarnings", "setShipToAddress", "shipToAddress"]) {
      expect(names, absent).not.toContain(absent);
    }
    // And the same dependency list.
    expect(code(printDoc).endsWith("},[id])")).toBe(true);
  });

  it("hands each panel the server's own refusal for its order", () => {
    const panels = tags.filter((tag) => tag.name === "ShipmentOrderPanel");
    expect(panels).toHaveLength(1);
    expect(panels[0].attr("removeRefusal")).toBe("removeOrderRefusal(removeOrderFacts(shipper, printedOrders, so))");
  });
});

describe("ShipmentDetail wiring, Task 4: the Add order section and the override reason", () => {
  /** The one element of this name whose `attribute` is exactly `value`. `SD` and `tags` are Task 2's,
   *  from the top of this file. */
  const theOne = (name: string, attribute: string, value: string) => {
    const found = tags.filter((tag) => tag.name === name && tag.attr(attribute) === value);
    expect(found, `<${name} ${attribute}=${value}>`).toHaveLength(1);
    return found[0];
  };

  it("the Add order list starts as loading, so it never says there is nothing to add before its first read answers", () => {
    // `addOrderSelect` words "ready" with no orders as "No unshipped orders for this customer".
    // The candidates effect sets "loading" itself, but one commit after the shipment lands.
    expect(declared(SD, "addableState")).toEqual(['useState<AddableState>("loading")']);
  });

  it("one gate asks for the override reason, after the lines gate and so after the invoice rung", () => {
    expect(declared(SD, "reasonGate")).toEqual([
      "reasonRequiredGate(linesAddGate, held && overrideGate.allowed, creditHoldReason)",
    ]);
  });

  it("the Add order button reads that gate, and words nothing about the hold itself", () => {
    const button = theOne("button", "onClick", "() => void addOrder()");
    expect(button.attr("disabled")).toBe("reasonGate.disabled || !addOrderChoice || addingOrder");
    // The gate's reason first; with the gate open, "Pick an order first" only while the list
    // offers an order and none is picked (#487, owner answer 1). The list offers one exactly
    // while its select is open: with the reason gate open the lines gate the select reads is open
    // too, so what is left is orders.view, a read that succeeded (state "ready") and an order to
    // add.
    expect(oneLine(button.attr("title"))).toBe(
      "addOrderButtonTitle({ gate: reasonGate, listOffers: !addSelect.disabled, choice: addOrderChoice })");
  });

  it("the Add order select reads the leaf's answer, built from the lines gate, orders.view and the read's state", () => {
    expect(declared(SD, "addSelect")).toEqual([
      "addOrderSelect({ gate: linesAddGate, ordersGate, state: addableState, count: addableOrders.length })",
    ]);
    const select = theOne("select", "value", "addOrderChoice");
    expect(select.attr("disabled")).toBe("addSelect.disabled");
    expect(select.attr("title")).toBe("addSelect.title");
  });

  it("every panel is handed the reason gate for Save lines, the lines gate for the rest of its Lines grid, and the reason as typed", () => {
    const panels = tags.filter((tag) => tag.name === "ShipmentOrderPanel");
    expect(panels).toHaveLength(1);
    expect(panels[0].attr("linesSaveGate")).toBe("reasonGate");
    expect(panels[0].attr("linesGate")).toBe("linesAddGate");
    expect(panels[0].attr("creditHoldReason")).toBe('held && overrideGate.allowed ? creditHoldReason : ""');
  });

  it("the reason box has the new form's name", () => {
    expect(theOne("input", "value", "creditHoldReason").attr("aria-label")).toBe("Credit hold override reason");
  });
});

describe("#483: the page waits for its permissions", () => {
  // jsx-source.ts reads JSX and declarations, not statements, so this walks the page's own syntax
  // tree, the way tests/shipment-grid-gates.test.ts builds its own source file. Parsed (#188): a
  // comment or a string that spells the early return is not one.
  const file = fileURLToPath(new URL(`../${SD}`, import.meta.url));
  const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  /** The returned expression of an `if`'s then-branch: a bare `return …;`, or a block that holds
   *  only that. `undefined` for any other branch. */
  const returned = (branch: ts.Statement): ts.Expression | undefined => {
    const only = ts.isBlock(branch) && branch.statements.length === 1 ? branch.statements[0] : branch;
    return ts.isReturnStatement(only) ? only.expression : undefined;
  };

  /** Whether `node` is the shared pre-load element, `<PageStatus …/>`, which says "Loading…" when
   *  it has no error (P6 step 3, #634; tests/list-status.test.tsx pins its markup). */
  const holdsLoading = (node: ts.Node): boolean =>
    (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "PageStatus")
    || (ts.forEachChild(node, (child) => holdsLoading(child) || undefined) ?? false);

  /** Every `if` of the page whose then-branch returns a JSX element, or any parenthesized
   *  expression, holding "Loading…". The walk takes either as a candidate; the second case below
   *  then asks that the one found returns a JSX element. */
  const loadingReturns = (): ts.IfStatement[] => {
    const found: ts.IfStatement[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isIfStatement(node)) {
        const value = returned(node.thenStatement);
        if (value !== undefined && (ts.isJsxSelfClosingElement(value) || ts.isJsxElement(value) || ts.isParenthesizedExpression(value)) && holdsLoading(value)) {
          found.push(node);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(tree);
    return found;
  };

  it("holds on its one \"Loading…\" while the shipment or the permission read is still out", () => {
    const found = loadingReturns();
    expect(found.map((statement) => oneLine(statement.getText(tree)))).toHaveLength(1);
    // Waiting on the permissions too means no control renders reading an in-flight permission array
    // as no grants. A failed permission read is not pending (src/lib/permission-ui.ts), so the page
    // still renders then, with that error in its banner.
    expect(oneLine(found[0].expression.getText(tree))).toBe("!shipper || permissionsPending(perms, permsError)");
  });

  it("shows what it showed before while it holds: the page's own errors first, then the permission read's", () => {
    const value = returned(loadingReturns()[0].thenStatement);
    expect(value !== undefined && ts.isJsxSelfClosingElement(value)).toBe(true);
    const element = value as ts.JsxSelfClosingElement;
    expect(element.tagName.getText(tree)).toBe("PageStatus");
    // The page's own chain, unchanged by the move (#634): PageStatus says "Loading…" when it is null.
    expect(element.attributes.properties.map((a) => oneLine(a.getText(tree)))).toEqual([
      "error={error ?? initialLoadError ?? permsError}",
    ]);
  });
});

describe("#484: the ship-to address each answer carries", () => {
  // Every answer `shipperResponse` writes carries the shipment's ship-to address beside `shipper`
  // (owner ruling 2026-10-15, "Payload address after commit, select open";
  // src/app/api/shippers/response.ts). These pin where the page takes it: from `load` and each
  // mutation's answer, in the branch that adopts `shipper`, and from nowhere else. The read after a
  // print takes none of it (Task 3's describe above). They also pin that the Ship-to select's own
  // option and the "Ships to:" line draw what the leaf answers (`shipToChoice`,
  // src/lib/shipment-ship-to.ts, whose rule tests/shipment-ship-to.test.ts proves), and that without
  // customers.view the gate's title shows beside the select, outside its label, while the select's
  // one lock stays the edit gate. Task 3's `source` and `written` are local to its describe, so this
  // one has its own.
  const source = readFileSync(fileURLToPath(new URL(`../${SD}`, import.meta.url)), "utf8");
  /** The one declaration of `name`, as written. */
  const written = (name: string): string => {
    const found = declared(SD, name);
    expect(found, name).toHaveLength(1);
    return found[0];
  };

  it("the answer's type carries the address beside `shipper`, `warnings` and `printed`", () => {
    expect(source).toContain(
      "export type ShipperMutationResult = { shipper: ShipperDetail; warnings: string[]; printed: PrintedOrders; shipToAddress: ShipToAddress | null };",
    );
  });

  it("holds the address in one state, empty until an answer lands", () => {
    // One declaration of the name, so no second binding of it (a local read off the address list)
    // can stand beside the state.
    expect(declared(SD, "shipToAddress")).toEqual(["useState<ShipToAddress | null>(null)"]);
  });

  // The stored Package count is noted in the same two branches (#653; tests/shipment-package-count.test.ts).
  it("assigns it from the page's own read, in the branch that adopts `shipper`", () => {
    expect(code(written("load"))).toContain(code(
      "if (mutations.accept(ticket)) { void recoveryRead.accept(res.shipper); setShipper(editGuard.applyPayload(res.shipper)); " +
      "storedPackageCount.current = res.shipper.packageCount; setWarnings(res.warnings); setPrintedOrders((seen) => mergePrinted(seen, res.printed)); setShipToAddress(res.shipToAddress); }",
    ));
  });

  it("assigns it from each mutation's answer, after the ticket is accepted and beside `shipper`", () => {
    expect(code(written("applyMutation"))).toContain(code(
      "if (!mutations.accept(ticket)) return; void recoveryRead.accept(res.shipper); setShipper(editGuard.applyPayload(res.shipper)); " +
      "storedPackageCount.current = res.shipper.packageCount; setWarnings(res.warnings); setPrintedOrders((seen) => mergePrinted(seen, res.printed)); setShipToAddress(res.shipToAddress);",
    ));
  });

  it("is set in those two places only, and the setter is never handed on uncalled", () => {
    expect(source.split("setShipToAddress(").length - 1).toBe(2);
    // Written three times in the whole file: where it is declared, and in those two calls. A fourth
    // would be a writer the count above cannot see, because it is not a call: the setter handed on
    // by reference (`.then(setShipToAddress)`) assigns whatever it is given.
    expect(mentions(SD, "setShipToAddress")).toBe(3);
  });

  it("asks the leaf once, with the address list, the shipment's set id and the address the answer carries", () => {
    expect(declared(SD, "shipTo")).toEqual([
      "shipToChoice({ listed: addresses, setId: shipper.shipToAddressId, answered: shipToAddress })",
    ]);
  });

  it("the Ship-to select keeps its value, its edit gate and its save", () => {
    const select = only("the Ship-to select", (tag) => tag.name === "select" && tag.attr("value") === 'shipper.shipToAddressId ?? ""');
    expect([select.attr("disabled"), select.attr("title"), oneLine(select.attr("onChange"))]).toEqual([
      "!editGate.allowed", "editGate.title", "(e) => void patchHeader({ shipToAddressId: e.target.value || null })",
    ]);
  });

  it("offers \"— none —\", then the leaf's own option when it answers one, then the list in the leaf's format", () => {
    // Where Carrier offers its own option: after "— none —" and before the list.
    expect(jsxTexts(SD, "select").filter((text) => text.includes("shipTo"))).toEqual([
      "<option> {shipTo.own !== null && <option value={shipTo.own.value}>{shipTo.own.label}</option>} " +
      "{addresses.map((a) => <option key={a.id} value={a.id}>{shipToOptionLabel(a)}</option>)}",
    ]);
  });

  it("\"Ships to:\" shows the leaf's text, on that alone", () => {
    expect(renderedFrom(SD, "p").filter((text) => text.includes("Ships to:")).map(oneLine)).toEqual([
      'shipTo.shipsTo !== null && ( <p className="mt-2 text-xs text-ink-500"> Ships to: {shipTo.shipsTo} </p> )',
    ]);
  });

  it("without customers.view, the gate's title shows as text beside the select, on that permission alone", () => {
    // No edit-gate or void condition beside it: the text says why the list holds no address but the
    // shipment's own, and that holds whether or not the select is open. As with the amber line
    // above, a condition on an element that encloses it is not read here.
    expect(renderedFrom(SD, "span").filter((text) => text.includes("customersGate")).map(oneLine)).toEqual([
      '!customersGate.allowed && (<span className="mt-1 block text-xs text-ink-500">{customersGate.title}</span>)',
    ]);
  });

  it("the text sits outside the select's label, so the select's accessible name stays \"Ship-to address\"", () => {
    expect(jsxTexts(SD, "label").filter((text) => text.startsWith("Ship-to address"))).toEqual(["Ship-to address <select>"]);
  });

  it("the select stays open without customers.view: its one lock is the edit gate", () => {
    // The row the Task 2 describe pins among every header field, asked again here: a clear is a
    // write the server accepts from a shipping.edit holder without customers.view.
    expect(headerFields().filter(([field]) => field === "shipToAddressId")).toEqual([
      ["shipToAddressId", "disabled", "!editGate.allowed", "editGate.title"],
    ]);
  });
});

// The readers above answer from the parser (tests/helpers/jsx-source.ts). Two of this file's pins
// once read the text through a pattern and failed open, so what the replacements do at exactly
// those edges is pinned here.
describe("the parsed readers this file leans on", () => {
  it("`code` drops comments and layout, and keeps a string whole with the code written after it", () => {
    // The pattern this replaced cut the first line at the `//` inside the address, `load()` and all.
    expect(code('const seeAlso = "https://example.invalid"; void load(); // gone\n  after(/* gone */ 1);'))
      .toBe('constseeAlso="https://example.invalid";voidload();after(1);');
    expect(code("api(`/a//b/${id} // kept`); // gone")).toBe("api(`/a//b/${id} // kept`);");
  });

  it("`identifiers` sees a name handed on uncalled, and not one a comment or a string spells", () => {
    expect(identifiers('void run().then(load); // reload()\nconst s = "mutations";')).toEqual(["run", "then", "load", "s"]);
  });

  it("`firstTryBlock` answers the outermost `try`'s own statements: not its catch's, its finally's, or a nested block's", () => {
    expect(firstTryBlock("async () => { before(); try { a(); if (x) { b(); } try { c(); } finally { d(); } e(); } catch { f(); } finally { g(); } }"))
      .toEqual(["a();", "if(x){b();}", "try{c();}finally{d();}", "e();"]);
    expect(firstTryBlock("() => { a(); }")).toEqual([]);
  });

  it("each refuses a snippet that does not parse, so a misread subject fails the test that asked", () => {
    for (const read of [code, identifiers, firstTryBlock]) expect(() => read("const = ;"), read.name).toThrow(/does not parse/);
  });
});
