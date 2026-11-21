import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { decimalRefusal } from "@/lib/decimal-entry";
import { ApiError, UnreadableAnswerError } from "@/lib/fetcher";
import { LINE_NET_WEIGHT } from "@/lib/order-boxes";
import { INVOICE_FREEZE, invoiceFreezeSentence } from "@/lib/invoice-freeze";
import {
  NO_FIELD_SAVES, anyNotSaved, checkLineField, cleared, dispatched, failed, fieldKey, fieldView, landed,
  reconciled, refused, restoreIntent, retained, saveIntent, serverValues, settled, typed, unansweredStatus,
  type FieldSaves, type FieldView, type LineField,
} from "@/lib/line-field-saves";
import {
  LINE_NOT_FOUND, NO_UNCONFIRMED_REMOVALS, alreadyRemovedMessage, anyRemovalUnconfirmed, removalProvesGone,
  removalUnanswered, removalsListed, removedNotRefreshedMessage, type UnconfirmedRemovals,
} from "@/lib/line-removals";
import { serialsScope } from "@/lib/unsaved-guard";
import { linesNaming } from "./helpers/ts-parse";
import type { OrderLine } from "../src/app/orders/[id]/page";

// How the order hub's Lines section is wired to its save-state leaf (the quantity corrections design
// §4). The leaf's own suite (line-field-saves.test.ts) proves every decision; this file proves the
// section asks it, and does the four things the leaf cannot: send the request, say from the error it
// caught whether the server answered, write the section's message, and register a Not saved value as
// unsaved work. It also proves which saves mark a line for an offered weight and which unmark it;
// what the section renders for a marked line is lines-section-offer.test.tsx's. The same holds for
// a line Remove the server did not answer (#475): line-removals.test.ts proves the leaf, this file
// proves the section marks the line, registers it, keeps Remove as the one retry, and reads the
// order through the page's callback after a Remove answered "Order line not found".
//
// vitest has no DOM, so nothing here renders the section. The first half reads LinesSection.tsx as
// a syntax tree. The second half lifts the section's own handler functions out of that tree and
// runs them against the real leaf, with a `setSaves` that applies each updater to a local Map, the
// way order-line-retained-scope.test.ts runs `removeLine`. A handler that gains a free identifier
// must gain it in `handlers()` below in the same change, or it is a ReferenceError here.
//
// The `addRider` block runs that handler the same way, over the Add rider strip's state and not the
// leaf: what it refuses before any request, in what words, and what it sends. The last block runs
// `removeLine`, and the section's `[lines]` effect, against the real removal leaf, each lifted into
// an environment of its own rather than through `handlers()`: the record of marks is a local Set
// changed through `setRemovals`, and every request and the page's read are held until answered.

const file = fileURLToPath(new URL("../src/app/orders/[id]/LinesSection.tsx", import.meta.url));
const text = readFileSync(file, "utf8");
const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function all<T extends ts.Node>(root: ts.Node, is: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const walk = (node: ts.Node): void => { if (is(node)) out.push(node); ts.forEachChild(node, walk); };
  walk(root);
  return out;
}
function declared(name: string): ts.FunctionDeclaration {
  const found = all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === name);
  if (found.length !== 1) throw new Error(`Expected one function ${name} in LinesSection.tsx, found ${found.length}`);
  return found[0];
}
const callsTo = (root: ts.Node, name: string) =>
  all(root, ts.isCallExpression).filter((c) => ts.isIdentifier(c.expression) && c.expression.text === name);

const section = declared("LinesSection");

// ---- the section's shape, read from its syntax tree ----

describe("LinesSection: registration", () => {
  it("registers a Not saved value, or a removal the server did not answer, as unsaved work, under the label Lines and with no scope", () => {
    const calls = callsTo(section, "useUnsavedSection");
    expect(calls).toHaveLength(1);
    const [dirty, label, ...rest] = calls[0].arguments;
    // The flag is the two leaves' answers over the current lines, never "an entry exists".
    expect(dirty.getText(source)).toBe("anyNotSaved(saves, server) || anyRemovalUnconfirmed(removals, lines)");
    expect(ts.isStringLiteral(label) && label.text).toBe("Lines");
    expect(rest).toHaveLength(0);
  });

  it("builds `server` from the lines it was handed, through the leaf", () => {
    const server = all(section, ts.isVariableDeclaration).filter((d) => d.name.getText(source) === "server");
    expect(server).toHaveLength(1);
    expect(server[0].initializer?.getText(source)).toBe("serverValues(lines)");
  });
});

describe("LinesSection: the two boxes", () => {
  type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  const isOpening = (n: ts.Node): n is Opening => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n);
  const attribute = (element: Opening, name: string): string | undefined => {
    const found = element.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(source) === name);
    return found && ts.isJsxAttribute(found) ? found.initializer?.getText(source) : undefined;
  };
  /** The callback `lines.map` renders each line with. */
  const lineRow = (): ts.ArrowFunction => {
    // The one in the JSX. The lines effect maps the lines to their ids, and is not this.
    const maps = all(section, ts.isCallExpression)
      .filter((c) => c.expression.getText(source) === "lines.map" && ts.isJsxExpression(c.parent));
    expect(maps).toHaveLength(1);
    const row = maps[0].arguments[0];
    if (!ts.isArrowFunction(row)) throw new Error("lines.map must take an arrow function");
    return row;
  };
  const box = (labelled: string): Opening => {
    const found = all(section, isOpening).filter((e) =>
      e.tagName.getText(source) === "input" && attribute(e, "aria-label") === `{\`\${lineLabel(line)} ${labelled}\`}`);
    expect(found).toHaveLength(1);
    return found[0];
  };

  it.each([
    ["quantity", "qty"],
    ["weight", "weight"],
  ])("the %s box keeps its label and saves on blur and on Enter", (labelled, field) => {
    const input = box(labelled);
    // Focus says which box it arrived in, by the same key the box's mark restores.
    expect(attribute(input, "onFocus")).toBe(`{(e) => noteFocus(${field}Key, e)}`);
    expect(attribute(input, "onChange")).toBe(`{(e) => onTyped(${field}Key, e.target.value)}`);
    expect(attribute(input, "onBlur")).toBe(`{(e) => onBlurField(e, line, "${field}")}`);
    expect(attribute(input, "onKeyDown")).toBe(`{(e) => onEnterField(e, line, "${field}")}`);
  });

  it.each([
    ["quantity", "qty"],
    ["weight", "weight"],
  ])("the %s box shows the leaf's view and is marked invalid, with its reason, while Not saved", (labelled, field) => {
    const input = box(labelled);
    expect(attribute(input, "value")).toBe(`{${field}.text}`);
    expect(attribute(input, "aria-invalid")).toBe(`{${field}.mark === "not-saved" ? true : undefined}`);
    // The box is described by its message exactly when that message is rendered: one condition
    // decides both, so the id the box names always exists.
    expect(attribute(input, "aria-describedby")).toBe(`{${field}Message !== null ? ${field}MessageId : undefined}`);
    const message = all(section, isOpening).filter((e) => attribute(e, "id") === `{${field}MessageId}`);
    expect(message).toHaveLength(1);
    const shown = message[0].parent.parent; // the `&&` the message element is the right side of
    expect(ts.isBinaryExpression(shown) && shown.left.getText(source)).toBe(`${field}Message !== null`);
    const messageOf = all(lineRow(), ts.isVariableDeclaration).filter((d) => d.name.getText(source) === `${field}Message`);
    expect(messageOf.map((d) => d.initializer?.getText(source))).toEqual([`fieldMessage(line, "${field}", ${field})`]);
    const view = all(lineRow(), ts.isVariableDeclaration).filter((d) => d.name.getText(source) === field);
    expect(view).toHaveLength(1);
    expect(view[0].initializer?.getText(source)).toBe(`fieldView(saves.get(${field}Key), stored(${field}Key))`);
  });

  it("each box has its mark, labelled as the box is, restoring that box", () => {
    const marks = all(section, isOpening).filter((e) => e.tagName.getText(source) === "FieldMark");
    expect(marks.map((m) => [
      attribute(m, "fieldLabel"), attribute(m, "view"), attribute(m, "server"), attribute(m, "onRestore"),
    ])).toEqual([
      ["{`${lineLabel(line)} quantity`}", "{qty}", "{stored(qtyKey)}", "{() => restore(qtyKey)}"],
      ["{`${lineLabel(line)} weight`}", "{weight}", "{stored(weightKey)}", "{() => restore(weightKey)}"],
    ]);
  });

  it("each line is an unconditional Fragment keyed by line id, so a detail row never remounts the boxes", () => {
    const row = lineRow();
    if (!ts.isBlock(row.body)) throw new Error("lines.map must take a block-bodied arrow");
    // One return in the whole callback, and it is the Fragment itself: never an early return, never
    // a choice between two elements.
    const returns = all(row.body, ts.isReturnStatement);
    expect(returns).toHaveLength(1);
    let returned = returns[0].expression;
    while (returned && ts.isParenthesizedExpression(returned)) returned = returned.expression;
    if (!returned || !ts.isJsxElement(returned)) throw new Error("lines.map must return one JSX element");
    expect(returned.openingElement.tagName.getText(source)).toBe("Fragment");
    expect(attribute(returned.openingElement, "key")).toBe("{line.id}");
    // Its first child is the line's own row, always; the detail row is the conditional one after it.
    const children = returned.children.filter((c) => !ts.isJsxText(c));
    expect(children).toHaveLength(2);
    expect(ts.isJsxElement(children[0]) && children[0].openingElement.tagName.getText(source)).toBe("tr");
    expect(ts.isJsxExpression(children[1])).toBe(true);
  });

  describe("the offered weight", () => {
    const declaredInRow = (name: string) =>
      all(lineRow(), ts.isVariableDeclaration).filter((d) => d.name.getText(source) === name);
    /** The node's source text with every run of whitespace removed, so a pin survives re-wrapping. */
    const squeezed = (node: ts.Node | undefined) => node?.getText(source).replace(/\s+/g, "");
    const note = (): Opening => {
      const found = all(section, isOpening).filter((e) => e.tagName.getText(source) === "WeightOfferNote");
      expect(found).toHaveLength(1);
      return found[0];
    };

    it("is derived at render, only for a line marked in this visit, from the order's own figures", () => {
      const offer = declaredInRow("offer");
      expect(offer).toHaveLength(1);
      expect(squeezed(offer[0].initializer)).toBe(
        "offerLines.has(line.id)?lineWeightOffer({quantity:line.qty,eachWeight:line.part.eachWeight,"
        + "storedWeight:line.weight,shippedWeight:shippedWeightByLineId.get(line.id),}):null");
    });

    it("is accepted through acceptOffer, which hands commit the figure as plain text, as the weight box's own save", () => {
      expect(attribute(note(), "offer")).toBe("{offer}");
      expect(attribute(note(), "onUse")).toBe("{() => acceptOffer(line, offer.pounds)}");
      // One caller, and one save: the handler sends through commit and nothing else.
      expect(callsTo(section, "acceptOffer")).toHaveLength(1);
      const accept = declared("acceptOffer");
      expect(callsTo(accept, "commit").map((c) => c.getText(source))).toEqual(['commit(line, "weight", text, null)']);
      const figure = all(accept, ts.isVariableDeclaration).filter((d) => d.name.getText(source) === "text");
      expect(figure.map((d) => d.initializer?.getText(source))).toEqual(["String(pounds)"]);
      for (const name of ["checkAndSend", "api", "applyMutation", "setSaves"]) expect(callsTo(accept, name), name).toHaveLength(0);
    });

    it("its control waits for the edit gate and for a save of either of the line's boxes, and says which", () => {
      expect(attribute(note(), "disabled")).toBe("{editGate.disabled || offerWaits}");
      expect(attribute(note(), "title")).toBe("{offerTitle}");
      // One condition decides both the wait and its reason, so the two cannot disagree. A quantity
      // save changes the figure this control would use; a weight save is the request it would send.
      expect(declaredInRow("offerWaits").map((d) => d.initializer?.getText(source))).toEqual(["qty.saving || weight.saving"]);
      expect(declaredInRow("offerTitle").map((d) => d.initializer?.getText(source))).toEqual([
        'editGate.title ?? (offerWaits ? "Wait for this save to finish before using this weight" : undefined)',
      ]);
    });

    it("sits in the line's detail row, which is rendered for an offer alone", () => {
      const shown = note().parent.parent.parent; // <p>, then ( … ), then the `&&` it is the right side of
      expect(ts.isBinaryExpression(shown) && shown.left.getText(source)).toBe("offer !== null");
      const row = lineRow();
      const detail = all(row, ts.isBinaryExpression).filter((b) => {
        let right: ts.Expression = b.right;
        while (ts.isParenthesizedExpression(right)) right = right.expression;
        return ts.isJsxElement(right) && right.openingElement.tagName.getText(source) === "tr";
      });
      expect(detail.map((b) => squeezed(b.left))).toEqual(["(removalMessage!==null||qtyMessage!==null||weightMessage!==null||offer!==null)"]);
    });
  });

  // #472. The re-pick takes no gate of its own: its select is disabled only while its own save is
  // out. So what keeps it shut under a closed gate is that it is not mounted then. A gate that
  // closes while a re-pick is open (the order voided, or an invoice finalized elsewhere and since
  // read by this page) puts the greyed, titled "change" button back in its place.
  describe("the quote re-pick", () => {
    const unwrapped = (node: ts.Expression): ts.Expression => {
      let inner = node;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      return inner;
    };
    /** The `a ? b : c` the section's one `<LineQuoteRepick>` is the middle of. */
    const choice = (): ts.ConditionalExpression => {
      const found = all(section, isOpening).filter((e) => e.tagName.getText(source) === "LineQuoteRepick");
      expect(found).toHaveLength(1);
      let around: ts.Node = found[0].parent;
      while (ts.isParenthesizedExpression(around)) around = around.parent;
      if (!ts.isConditionalExpression(around)) throw new Error("<LineQuoteRepick> must be one side of a conditional");
      expect(unwrapped(around.whenTrue)).toBe(found[0]);
      return around;
    };

    it("is mounted for the line it was opened on, and only while the edit gate is open", () => {
      expect(choice().condition.getText(source)).toBe("repickLineId === line.id && !editGate.disabled");
    });

    it("otherwise the line shows the change button, which opens the re-pick and carries the edit gate", () => {
      const button = unwrapped(choice().whenFalse);
      if (!ts.isJsxElement(button)) throw new Error("the other side must be one JSX element");
      const opening = button.openingElement;
      expect(opening.tagName.getText(source)).toBe("button");
      expect(attribute(opening, "onClick")).toBe("{() => setRepickLineId(line.id)}");
      // The property the mount condition reads is the one that disables the button, so the two
      // cannot disagree: under a closed gate the line shows a disabled button with the gate's
      // reason, and never an open re-pick.
      expect(attribute(opening, "disabled")).toBe("{editGate.disabled}");
      expect(attribute(opening, "title")).toBe("{editGate.title}");
      expect(button.children.map((c) => c.getText(source).trim()).join("")).toBe("change");
    });
  });
});

describe("LinesSection: state discipline", () => {
  const LEAF_TRANSITIONS = ["cleared", "dispatched", "failed", "landed", "reconciled", "refused", "settled", "typed"];

  it("every change to the save state is a functional update through one leaf transition", () => {
    const calls = callsTo(section, "setSaves");
    const through = calls.map((call) => {
      const [update] = call.arguments;
      // `setSaves((cur) => transition(cur, …))`: built from the state React holds, never from the
      // render's copy, so an update queued by a response cannot be overwritten by a handler's.
      if (!ts.isArrowFunction(update) || update.parameters.length !== 1) return `not functional: ${call.getText(source)}`;
      const body = update.body;
      if (!ts.isCallExpression(body) || !ts.isIdentifier(body.expression)) return `not one transition: ${call.getText(source)}`;
      if (body.arguments[0]?.getText(source) !== update.parameters[0].name.getText(source)) return `not from current state: ${call.getText(source)}`;
      return body.expression.text;
    });
    expect([...new Set(through)].sort()).toEqual(LEAF_TRANSITIONS);
  });

  it("one effect, keyed on the lines payload alone, reconciles the save state against it", () => {
    const effects = callsTo(section, "useEffect").filter((effect) => callsTo(effect, "reconciled").length > 0);
    expect(effects).toHaveLength(1);
    const [run, deps] = effects[0].arguments;
    expect(deps.getText(source)).toBe("[lines]");
    expect(callsTo(run, "reconciled").map((c) => c.getText(source))).toEqual(["reconciled(cur, serverValues(lines))"]);
  });

  it("every change to the offered lines is a functional update: a landing, or the lines payload", () => {
    const calls = callsTo(section, "setOfferLines");
    expect(calls.map((call) => call.arguments[0].getText(source)).sort()).toEqual([
      "(cur) => offerLinesAfter(cur, line.id, field)",
      "(cur) => retained(cur, lines.map((l) => l.id))",
    ]);
  });

  it("the lines effect also drops the offer of a line that is gone", () => {
    const effects = callsTo(section, "useEffect").filter((effect) => callsTo(effect, "reconciled").length > 0);
    expect(effects).toHaveLength(1);
    expect(callsTo(effects[0].arguments[0], "setOfferLines")).toHaveLength(1);
    expect(callsTo(effects[0].arguments[0], "retained").map((c) => c.getText(source)))
      .toEqual(["retained(cur, lines.map((l) => l.id))"]);
  });

  it("the page hands the section what has shipped by weight, from the order's own ledger", () => {
    const pageFile = fileURLToPath(new URL("../src/app/orders/[id]/page.tsx", import.meta.url));
    const page = ts.createSourceFile(pageFile, readFileSync(pageFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const mounts = all(page, ts.isJsxSelfClosingElement).filter((e) => e.tagName.getText(page) === "LinesSection");
    expect(mounts).toHaveLength(1);
    const prop = mounts[0].attributes.properties
      .find((p) => ts.isJsxAttribute(p) && p.name.getText(page) === "shippedWeightByLineId");
    expect(prop && ts.isJsxAttribute(prop) && prop.initializer?.getText(page)).toBe("{shippedWeightByLineId}");
    const built = all(page, ts.isVariableDeclaration).filter((d) => d.name.getText(page) === "shippedWeightByLineId");
    expect(built.map((d) => d.initializer?.getText(page))).toEqual([
      "new Map(order.orderLineShippedToDate.map((s) => [s.orderLineId, s.shippedToDateWeight]))",
    ]);
  });

  it("never writes the order itself: the section names no setOrder", () => {
    expect(linesNaming(text, "setOrder")).toEqual([]);
  });

  it("imports types only from the page that mounts it", () => {
    const fromPage = all(source, ts.isImportDeclaration)
      .filter((i) => ts.isStringLiteral(i.moduleSpecifier) && i.moduleSpecifier.text === "./page");
    expect(fromPage).toHaveLength(1);
    expect(fromPage[0].importClause?.isTypeOnly).toBe(true);
  });

  it("sends every line request itself, inline, with a literal method", () => {
    const requests = callsTo(source, "api").filter((c) => c.arguments[0]?.getText(source).includes("/lines"));
    expect(requests.map((c) => [c.arguments[0].getText(source), c.arguments[1]?.getText(source).match(/method: "[A-Z]+"/)?.[0]])).toEqual([
      ["`/api/orders/${orderId}/lines/${line.id}`", 'method: "PATCH"'], // the quote re-pick
      ["`/api/orders/${orderId}/lines/${line.id}`", 'method: "PATCH"'], // checkAndSend: every Qty and Weight save
      ["`/api/orders/${orderId}/lines/${line.id}`", 'method: "DELETE"'], // removeLine
      ["`/api/orders/${orderId}/lines`", 'method: "POST"'], // addRider
    ]);
  });
});

describe("LinesSection: one request path for Qty and Weight", () => {
  it("commit and Restore both send through checkAndSend, and nothing else does", () => {
    expect(callsTo(section, "checkAndSend").map((c) => c.getText(source)).sort()).toEqual([
      "checkAndSend(line, field, String(line[field]))", // Restore: the value the page holds for that box
      "checkAndSend(line, field, text)", // commit: the text it was handed
    ]);
    expect(callsTo(declared("commit"), "checkAndSend")).toHaveLength(1);
    expect(callsTo(declared("restore"), "checkAndSend")).toHaveLength(1);
  });

  it("only checkAndSend takes a request to the server or records how an attempt ended", () => {
    const sender = declared("checkAndSend");
    for (const name of ["dispatched", "landed", "failed", "refused"]) {
      expect(callsTo(section, name), name).toHaveLength(1);
      expect(callsTo(sender, name), name).toHaveLength(1);
    }
    for (const handler of ["commit", "restore"]) {
      for (const name of ["api", "applyMutation"]) expect(callsTo(declared(handler), name), `${handler}: ${name}`).toHaveLength(0);
    }
    expect(callsTo(sender, "applyMutation")).toHaveLength(1);
    expect(callsTo(sender, "api")).toHaveLength(1);
  });

  it("Restore asks the leaf what to do, from the save state this render holds", () => {
    expect(callsTo(section, "restoreIntent").map((c) => c.getText(source))).toEqual(["restoreIntent(saves.get(key))"]);
    expect(callsTo(declared("restore"), "restoreIntent")).toHaveLength(1);
  });

  it("a failure is unanswered unless it is an answer from the server with a status below 500", () => {
    const sender = declared("checkAndSend");
    // R13 is the leaf's (`unansweredStatus`), asked of the status the error carries: none when it
    // is not an answer from the server. Remove asks it of the same status, read the same way.
    for (const handler of [sender, declared("removeLine")]) {
      const status = all(handler, ts.isVariableDeclaration).filter((d) => d.name.getText(source) === "status");
      expect(status.map((d) => d.initializer?.getText(source))).toEqual(["e instanceof ApiError ? e.status : null"]);
    }
    const flag = all(sender, ts.isVariableDeclaration).filter((d) => d.name.getText(source) === "unanswered");
    expect(flag.map((d) => d.initializer?.getText(source))).toEqual(["unansweredStatus(status)"]);
    expect(callsTo(sender, "failed").map((c) => c.getText(source))).toEqual(["failed(cur, key, attempt, message, unanswered)"]);
    // The class is the one `api()` throws: imported from the fetcher, as a value.
    const fromFetcher = all(source, ts.isImportSpecifier).filter((i) => i.name.text === "ApiError");
    expect(fromFetcher).toHaveLength(1);
    const declaration = fromFetcher[0].parent.parent.parent;
    expect(ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text).toBe("@/lib/fetcher");
    expect(fromFetcher[0].isTypeOnly || declaration.importClause?.isTypeOnly).toBeFalsy();
  });
});

// A line Remove the server did not answer (#475, owner ruling 2026-10-15, "Mark until gone"). What
// the section holds, where it changes it, and the one place it reads the order. What it renders is
// lines-section-offer.test.tsx's; what the handler does is the last block of this file.
describe("LinesSection: a removal the server did not answer (#475)", () => {
  type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  const isOpening = (n: ts.Node): n is Opening => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n);
  const attribute = (element: Opening, name: string): string | undefined => {
    const found = element.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(source) === name);
    return found && ts.isJsxAttribute(found) ? found.initializer?.getText(source) : undefined;
  };
  const remover = () => declared("removeLine");
  /** The variables of `name` the callback `lines.map` renders each line with declares. */
  const inRow = (name: string): ts.VariableDeclaration[] => {
    const maps = all(section, ts.isCallExpression)
      .filter((c) => c.expression.getText(source) === "lines.map" && ts.isJsxExpression(c.parent));
    expect(maps).toHaveLength(1);
    return all(maps[0].arguments[0], ts.isVariableDeclaration).filter((d) => d.name.getText(source) === name);
  };
  /** The nearest `if` above `node`, which `node` must sit in the then-branch of, however deep. */
  const enclosingIf = (node: ts.Node): ts.IfStatement => {
    let child: ts.Node = node;
    let at: ts.Node = node.parent;
    while (!ts.isIfStatement(at)) { child = at; at = at.parent; }
    expect(at.thenStatement).toBe(child);
    return at;
  };
  /** The left side of the `cond && <element>` an element is rendered by. */
  const shownWhen = (element: Opening): string | undefined => {
    let at: ts.Node = ts.isJsxOpeningElement(element) ? element.parent : element;
    do at = at.parent; while (ts.isParenthesizedExpression(at));
    return ts.isBinaryExpression(at) ? at.left.getText(source) : undefined;
  };
  /** The `<td>` an element sits in. */
  const cellOf = (element: Opening): ts.JsxElement => {
    let at: ts.Node = element.parent;
    while (!(ts.isJsxElement(at) && at.openingElement.tagName.getText(source) === "td")) at = at.parent;
    return at;
  };
  const removeButton = (): ts.JsxOpeningElement => {
    const found = all(section, ts.isJsxElement).filter((e) => e.openingElement.tagName.getText(source) === "button"
      && e.children.map((c) => c.getText(source).trim()).join("") === "Remove");
    expect(found).toHaveLength(1);
    return found[0].openingElement;
  };

  it("holds one record of them, a Set of line ids that starts as the leaf's empty one", () => {
    const states = callsTo(section, "useState").filter((c) => c.getText(source).includes("UnconfirmedRemovals"));
    expect(states.map((c) => c.getText(source))).toEqual(["useState<UnconfirmedRemovals>(NO_UNCONFIRMED_REMOVALS)"]);
    const declaration = states[0].parent;
    expect(ts.isVariableDeclaration(declaration) && declaration.name.getText(source)).toBe("[removals, setRemovals]");
  });

  it("changes it only by a functional update through one leaf transition: a Remove with no answer, or the lines payload", () => {
    expect(callsTo(section, "setRemovals").map((c) => c.arguments[0].getText(source)).sort()).toEqual([
      "(cur) => removalUnanswered(cur, line.id)",
      "(cur) => removalsListed(cur, lines.map((l) => l.id))",
    ]);
    // The payload's, in the one `[lines]` effect beside the save state's and the offer's: a
    // payload that no longer lists the line is the one thing that ends a mark.
    const effects = callsTo(section, "useEffect").filter((effect) => callsTo(effect, "reconciled").length > 0);
    expect(effects).toHaveLength(1);
    expect(callsTo(effects[0].arguments[0], "setRemovals").map((c) => c.getText(source)))
      .toEqual(["setRemovals((cur) => removalsListed(cur, lines.map((l) => l.id)))"]);
    // The mark's, in removeLine, and only where R13 says the server did not answer.
    const marking = callsTo(remover(), "setRemovals");
    expect(marking).toHaveLength(1);
    expect(enclosingIf(marking[0]).expression.getText(source)).toBe("unansweredStatus(status)");
  });

  it("Remove is the one way a removal is sent or retried, and a mark closes nothing", () => {
    const button = removeButton();
    expect(attribute(button, "onClick")).toBe("{() => void removeLine(line)}");
    // The edit gate alone: a mark never disables Remove, which is the retry.
    expect(attribute(button, "disabled")).toBe("{editGate.disabled}");
    expect(attribute(button, "title")).toBe("{editGate.title}");
    const calls = callsTo(section, "removeLine");
    expect(calls).toHaveLength(1);
    let at: ts.Node = calls[0];
    while (!ts.isJsxAttribute(at)) at = at.parent;
    expect(at.parent.parent).toBe(button);
    // Nor the line's boxes: on a marked line Qty and Net weight stay as editable as on any other.
    const boxes = all(section, isOpening).filter((e) => e.tagName.getText(source) === "input"
      && /^\{`\$\{lineLabel\(line\)\} (quantity|weight)`\}$/.test(attribute(e, "aria-label") ?? ""));
    expect(boxes.map((e) => attribute(e, "disabled"))).toEqual(["{editGate.disabled}", "{editGate.disabled}"]);
  });

  it("reads the order once, through the page's callback, and only where the Remove's answer proves the line gone", () => {
    const proofs = callsTo(section, "removalProvesGone");
    expect(proofs.map((c) => c.getText(source))).toEqual(["removalProvesGone(status, message)"]);
    expect(callsTo(remover(), "removalProvesGone")).toHaveLength(1);
    // The one read: in removeLine, so no Qty or Net weight save reads, whatever it is answered.
    const reads = callsTo(section, "readAfterRemoval");
    expect(reads.map((c) => c.getText(source))).toEqual(["readAfterRemoval()"]);
    expect(callsTo(remover(), "readAfterRemoval")).toHaveLength(1);
    expect(enclosingIf(reads[0]).expression).toBe(proofs[0]);
  });

  it("names the line in the messages as the confirm names it, built once", () => {
    const naming = all(remover(), ts.isVariableDeclaration).filter((d) => d.name.getText(source) === "naming");
    expect(naming.map((d) => d.initializer?.getText(source)))
      .toEqual(["`${line.part.customer.code} · ${line.part.partNumber} (${lineLabel(line)})`"]);
    expect(callsTo(remover(), "askConfirm").map((c) => c.getText(source)))
      .toEqual(['askConfirm({ title: `Remove ${naming} from this order?`, body: "", confirm: "Remove line", danger: true })']);
  });

  it("says why in the line's detail row, first, and marks the line beside Remove, on the one condition", () => {
    expect(inRow("removalMessage").map((d) => d.initializer?.getText(source)))
      .toEqual(["removalNotice(removals, line.id, lineLabel(line))"]);
    expect(inRow("removalMessageId").map((d) => d.initializer?.getText(source))).toEqual(["`line-${line.id}-removal-message`"]);
    const reason = all(section, isOpening).filter((e) => attribute(e, "id") === "{removalMessageId}");
    expect(reason).toHaveLength(1);
    expect(shownWhen(reason[0])).toBe("removalMessage !== null");
    // The first thing in the detail row's cell, before the boxes' messages and the offer.
    const detailCell = cellOf(reason[0]);
    const first = detailCell.children.find((c) => !ts.isJsxText(c));
    expect(first && reason[0].parent.parent.parent === first).toBe(true);
    // Remove is described by the reason exactly when it is rendered.
    expect(attribute(removeButton(), "aria-describedby")).toBe("{removalMessage !== null ? removalMessageId : undefined}");
    // The mark: the leaf's words, labelled as a box's Not saved mark is, in Remove's own cell.
    const marks = all(section, isOpening).filter((e) => attribute(e, "aria-label") === "{`${lineLabel(line)} removal not confirmed`}");
    expect(marks).toHaveLength(1);
    expect(marks[0].tagName.getText(source)).toBe("span");
    expect(attribute(marks[0], "role")).toBe('"alert"');
    expect(shownWhen(marks[0])).toBe("removalMessage !== null");
    const mark = marks[0].parent;
    expect(ts.isJsxElement(mark) && mark.children.map((c) => c.getText(source).trim()).join("")).toBe("{REMOVAL_NOT_CONFIRMED}");
    expect(cellOf(marks[0])).toBe(cellOf(removeButton()));
  });

  describe("the page's callback", () => {
    const pageFile = fileURLToPath(new URL("../src/app/orders/[id]/page.tsx", import.meta.url));
    const page = ts.createSourceFile(pageFile, readFileSync(pageFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const callback = (): ts.CallExpression => {
      const built = all(page, ts.isVariableDeclaration).filter((d) => d.name.getText(page) === "readAfterRemoval");
      expect(built).toHaveLength(1);
      const init = built[0].initializer;
      if (!init || !ts.isCallExpression(init) || init.expression.getText(page) !== "useCallback") {
        throw new Error("readAfterRemoval must be a useCallback in page.tsx");
      }
      return init;
    };
    /** The callback's own function, closed over `environment` and nothing else. */
    const run = (environment: Record<string, unknown>): (() => Promise<void>) => {
      const body = ts.transpileModule(`return (${callback().arguments[0].getText(page)});`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
      }).outputText;
      return new Function(...Object.keys(environment), body)(...Object.values(environment)) as () => Promise<void>;
    };

    it("is what the one mount of the section is handed", () => {
      const mounts = all(page, ts.isJsxSelfClosingElement).filter((e) => e.tagName.getText(page) === "LinesSection");
      expect(mounts).toHaveLength(1);
      const prop = mounts[0].attributes.properties
        .find((p) => ts.isJsxAttribute(p) && p.name.getText(page) === "readAfterRemoval");
      expect(prop && ts.isJsxAttribute(prop) && prop.initializer?.getText(page)).toBe("{readAfterRemoval}");
      expect(callback().arguments[1]?.getText(page)).toBe("[load]");
    });

    it("tells History and Shipments, and then reads the order through load", async () => {
      const told: string[] = [];
      let answer!: () => void;
      const load = vi.fn(() => { told.push("load"); return new Promise<void>((resolve) => { answer = resolve; }); });
      const read = run({
        invalidateHistory: () => told.push("history"), invalidateOrderShipments: () => told.push("shipments"), load,
      });
      let settled = false;
      const done = read().then(() => { settled = true; });
      expect(told).toEqual(["history", "shipments", "load"]);
      await flush();
      expect(settled).toBe(false); // it ends when the read ends
      answer();
      await done;
      expect(load).toHaveBeenCalledOnce();
    });

    it("passes a failed read on to the section, after both have been told", async () => {
      const told: string[] = [];
      const failure = new Error("Failed to fetch");
      const read = run({
        invalidateHistory: () => told.push("history"), invalidateOrderShipments: () => told.push("shipments"),
        load: async () => { throw failure; },
      });
      await expect(read()).rejects.toBe(failure);
      expect(told).toEqual(["history", "shipments"]);
    });
  });
});

// ---- the section's own handlers, run against the real leaf ----

const transpiled = new Map<string, string>();
/** The production function declaration `name`, closed over `environment` and nothing else. */
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let body = transpiled.get(name);
  if (body === undefined) {
    body = ts.transpileModule(`return (${declared(name).getText(source)});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    transpiled.set(name, body);
  }
  return new Function(...Object.keys(environment), body)(...Object.values(environment)) as T;
}

type Line = Pick<OrderLine, "id" | "position" | "qty" | "weight">;
const LEAD: Line = { id: "L1", position: 1, qty: 32, weight: 60 };
/** A second line on the order. No test touches its boxes: it is there so a handler that finds a
 *  box's line by key has more than one line to find it among. */
const RIDER: Line = { id: "L2", position: 2, qty: 5, weight: 9 };
const BELOW_SHIPPED = "Line 1 (ACME · P-A): cannot reduce qty below 30 already shipped";
const NOT_WHOLE = "Lead: quantity must be a whole number of at least 1.";
/** The order's own 409. It names no line and no field, so two boxes, or two sections of the page,
 *  can be told it in the same words. */
const CONFLICT = "Another change to that order was saved at the same time — please try again";
const lineLabel = actual<(line: Line) => string>("lineLabel", {});
type OfferLinesAfter = (cur: ReadonlySet<string>, lineId: string, field: LineField) => ReadonlySet<string>;
const offerLinesAfter = actual<OfferLinesAfter>("offerLinesAfter", {});

/** What the browser's fetch rejects with when no response arrives. */
const NO_ANSWER = "Failed to fetch";

type Commit = (line: Line, field: LineField, text: string, atFocus: string | null) => Promise<void>;
type CheckAndSend = (line: Line, field: LineField, text: string) => Promise<void>;
type FieldHandler = (e: unknown, line: Line, field: LineField) => void;
type NoteFocus = (key: string, e: unknown) => void;
type AcceptOffer = (line: Line, pounds: number) => void;
type Request = {
  url: string; init: { method: string; body: string };
  lands: () => void;
  /** The server answered with an error status. `api()` rejects with an ApiError that carries it;
   *  400 is what the line service answers a value it refuses with. */
  fails: (message: string, status?: number) => void;
  /** No response arrived. `api()` lets fetch's own rejection through: a TypeError, with no status. */
  drops: (message?: string) => void;
  /** The request, or the page's handling of its answer, ends with this error, whatever it is. */
  rejects: (error: unknown) => void;
};
/** One macrotask: every continuation of the requests settled so far has run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** What the section hands `onError`, which is the section's own React state setter for its message
 *  (P6 step 5a): a message, null to clear it, or a function of the message shown now. */
type BannerWrite = string | null | ((cur: string | null) => string | null);

/** One mounted Lines section over the lead line: its state, its refs and its props, with every
 *  request held open until the test lands, fails or drops it. */
function mounted() {
  /** The lead line as the page holds it now. */
  let line: Line = LEAD;
  let saves: FieldSaves = NO_FIELD_SAVES;
  const setSaves = (update: (cur: FieldSaves) => FieldSaves) => { saves = update(saves); };
  const attempts = { current: 0 };
  const newest = { current: new Map<string, number>() };
  const focusedValue = { current: "" };
  const focusedKey: { current: string | null } = { current: null };
  /** The section's message: one slot for the whole section, which the section holds. `onError` writes
   *  it as a state setter does, so a function is applied to the value shown now. A call
   *  is still recorded as it was made: a message, null, or that function. */
  let banner: string | null = null;
  const onError = vi.fn((write: BannerWrite) => { banner = typeof write === "function" ? write(banner) : write; });
  /** The section's own record: which of its boxes last wrote a failure to the message, and the words. */
  const bannerOwner: { current: { key: string; message: string } | null } = { current: null };
  const order: string[] = [];
  const requests: Request[] = [];
  const api = vi.fn((url: string, init: Request["init"]) => new Promise((resolve, reject) => {
    order.push("api");
    requests.push({
      url, init,
      lands: () => resolve({}),
      fails: (message, status = 400) => reject(new ApiError(message, status)),
      drops: (message = NO_ANSWER) => reject(new TypeError(message)),
      rejects: (error) => reject(error),
    });
  }));
  const applyMutation = vi.fn(async (run: () => Promise<unknown>) => { order.push("applyMutation"); await run(); });
  const stored = (key: string) => serverValues([line]).get(key) ?? "";
  let offerLines: ReadonlySet<string> = new Set();
  const setOfferLines = (update: (cur: ReadonlySet<string>) => ReadonlySet<string>) => { offerLines = update(offerLines); };
  /** The handlers as the latest render closes over them: `saves` and `lines` are that render's copy. */
  function handlers() {
    // The one request path. `commit` and `restore` are handed it and none of what it is made of,
    // so neither can send a request, take an attempt number or record how an attempt ended.
    const checkAndSend = actual<CheckAndSend>("checkAndSend", {
      orderId: "order-a", setSaves, onError, attempts, newest, bannerOwner, applyMutation, api, ApiError, lineLabel,
      fieldKey, refused, dispatched, landed, failed, checkLineField, setOfferLines, offerLinesAfter, unansweredStatus,
    });
    // The one way a box takes its message off the message with no request. `commit` and `restore`
    // are handed it and not `onError`, so neither can write the message in any other way.
    const clearOwnBanner = actual<(key: string) => void>("clearOwnBanner", { bannerOwner, onError });
    const commit = actual<Commit>("commit", {
      saves, stored, setSaves, fieldKey, saveIntent, settled, checkAndSend, clearOwnBanner,
    });
    return {
      commit,
      noteFocus: actual<NoteFocus>("noteFocus", { focusedValue, focusedKey }),
      onTyped: actual<(key: string, text: string) => void>("onTyped", { setSaves, typed }),
      onBlurField: actual<FieldHandler>("onBlurField", { focusedValue, focusedKey, fieldKey, commit }),
      onEnterField: actual<FieldHandler>("onEnterField", { focusedValue, commit }),
      acceptOffer: actual<AcceptOffer>("acceptOffer", { focusedValue, focusedKey, fieldKey, commit }),
      restore: actual<(key: string) => void>("restore", {
        saves, lines: [RIDER, line], stored, setSaves, cleared, restoreIntent, fieldKey, checkAndSend, clearOwnBanner,
        focusedValue, focusedKey,
      }),
    };
  }
  const view = (field: LineField) => fieldView(saves.get(fieldKey(line.id, field)), stored(fieldKey(line.id, field)));
  return {
    requests, order, onError, applyMutation, view,
    /** What the section's message says now. */
    banner: () => banner,
    /** The message written by anything but a Qty or Weight box: this section's Remove, Add rider or
     *  quote re-pick. All of them go through the section's setter. */
    elsewhere: (message: string | null) => { banner = message; },
    /** The section's record of which box last wrote a failure to the message, and the words it wrote. */
    owner: () => bannerOwner.current,
    saves: () => saves,
    entry: (field: LineField) => saves.get(fieldKey(line.id, field)),
    /** What the section registers as unsaved work: the argument its `useUnsavedSection` call is
     *  pinned to above, over this state. The traveler print waits while it is true. */
    notSaved: () => anyNotSaved(saves, serverValues([line])),
    // Each event carries the box's own text, as a controlled input's does.
    focus: (field: LineField) => handlers().noteFocus(fieldKey(line.id, field), { target: { value: view(field).text } }),
    /** The section's two focus refs: which box has focus, and the text it held at focus. */
    focused: () => ({ key: focusedKey.current, text: focusedValue.current }),
    type: (field: LineField, typedText: string) => handlers().onTyped(fieldKey(line.id, field), typedText),
    blur: (field: LineField) => handlers().onBlurField({ target: { value: view(field).text } }, line, field),
    enter: (field: LineField) => handlers().onEnterField({ key: "Enter", currentTarget: { value: view(field).text } }, line, field),
    restore: (field: LineField) => handlers().restore(fieldKey(line.id, field)),
    /** The handlers of the render on screen now, for a caller to keep. An answer is not an event:
     *  the save state it writes can be a render ahead of these for an instant, and a click or a
     *  blur in that instant runs them over the state they closed over. */
    rendered: () => {
      const onScreen = handlers();
      return {
        blur: (field: LineField, boxText: string) => onScreen.onBlurField({ target: { value: boxText } }, line, field),
        restore: (field: LineField) => onScreen.restore(fieldKey(line.id, field)),
      };
    },
    /** The Use control of the lead line's offer: the section's own handler, which sends the figure
     *  as a weight save. Called after `focus("weight")` with no blur between, it is the pointer's
     *  Use: focus stays in the weight box. */
    use: (pounds: number) => handlers().acceptOffer(line, pounds),
    /** A fresh order from anywhere, holding these values for the lead line: the page hands the
     *  section new `lines`, and the section's one `[lines]` effect, pinned above as text, runs. */
    payload: (holds: Partial<Pick<Line, "qty" | "weight">>) => {
      line = { ...line, ...holds };
      setSaves((cur) => reconciled(cur, serverValues([line])));
    },
    offered: () => [...offerLines],
    offerLines: () => offerLines,
  };
}

describe("commit", () => {
  it("a quantity save PATCHes the line with a number, through applyMutation, and the box reads Saved", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", " 040 "); s.blur("qty");
    expect(s.order).toEqual(["applyMutation", "api"]);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0].url).toBe("/api/orders/order-a/lines/L1");
    expect(s.requests[0].init).toEqual({ method: "PATCH", body: '{"qty":40}' });
    // In flight: the box shows exactly what was sent.
    expect(s.entry("qty")).toEqual({ draft: "40", pending: { attempt: 1, text: "40" }, outcome: null });
    expect(s.onError).not.toHaveBeenCalled();
    s.requests[0].lands();
    await flush();
    expect(s.view("qty")).toEqual({ text: "40", mark: "saved", message: null, saving: false });
    expect(s.onError.mock.calls).toEqual([[null]]);
  });

  it("a weight save sends the trimmed text as it was typed", () => {
    const s = mounted();
    s.focus("weight"); s.type("weight", " 48.50 "); s.blur("weight");
    expect(s.requests[0].init).toEqual({ method: "PATCH", body: '{"weight":"48.50"}' });
    expect(s.entry("weight")).toEqual({ draft: "48.50", pending: { attempt: 1, text: "48.50" }, outcome: null });
  });

  it("a value the client refuses sends nothing, reads Not saved, and is reported on the section's message", () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "4o"); s.blur("qty");
    expect(s.applyMutation).not.toHaveBeenCalled();
    expect(s.view("qty")).toEqual({ text: "4o", mark: "not-saved", message: NOT_WHOLE, saving: false });
    expect(s.onError.mock.calls).toEqual([[NOT_WHOLE]]);
  });

  it("a value the server refuses reads Not saved with the server's words, on the box and on the message", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "20"); s.blur("qty");
    s.requests[0].fails(BELOW_SHIPPED);
    await flush();
    expect(s.view("qty")).toEqual({ text: "20", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
    expect(s.onError.mock.calls).toEqual([[BELOW_SHIPPED]]);
  });

  it("attempt numbers come from one counter for the whole section", () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.focus("qty"); s.type("qty", "45"); s.blur("qty");
    s.focus("weight"); s.type("weight", "5"); s.blur("weight");
    expect(s.requests.map((r) => r.init.body)).toEqual(['{"qty":40}', '{"qty":45}', '{"weight":"5"}']);
    expect(s.entry("qty")?.pending).toEqual({ attempt: 2, text: "45" });
    expect(s.entry("weight")?.pending).toEqual({ attempt: 3, text: "5" });
  });

  it("a save that a newer one replaced does not clear the message when it lands", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.focus("qty"); s.type("qty", "45"); s.blur("qty");
    s.requests[0].lands();
    await flush();
    expect(s.onError).not.toHaveBeenCalled();
    // The newer save is still the one the box is waiting on, and it is the one that reports.
    expect(s.view("qty")).toEqual({ text: "45", mark: null, message: null, saving: true });
    s.requests[1].fails(BELOW_SHIPPED);
    await flush();
    expect(s.onError.mock.calls).toEqual([[BELOW_SHIPPED]]);
  });

  it("a save that a newer one replaced does not set the message when it fails", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "20"); s.blur("qty");
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.requests[0].fails(BELOW_SHIPPED);
    await flush();
    expect(s.onError).not.toHaveBeenCalled();
    expect(s.view("qty")).toEqual({ text: "40", mark: null, message: null, saving: true });
  });

  it("a client-side refusal typed over a save in flight keeps the message when that older save lands", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.focus("qty"); s.type("qty", "4o"); s.blur("qty");
    expect(s.requests).toHaveLength(1);
    s.requests[0].lands();
    await flush();
    expect(s.onError.mock.calls).toEqual([[NOT_WHOLE]]);
    expect(s.view("qty")).toEqual({ text: "4o", mark: "not-saved", message: NOT_WHOLE, saving: false });
  });

  it("a client-side refusal typed over a save in flight keeps the message when that older save fails", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.focus("qty"); s.type("qty", "4o"); s.blur("qty");
    s.requests[0].fails(BELOW_SHIPPED);
    await flush();
    expect(s.onError.mock.calls).toEqual([[NOT_WHOLE]]);
  });

  it("the stored value typed back into a clean box settles: no request, the draft goes, the message is left alone", () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.type("qty", "32.0"); s.blur("qty");
    expect(s.applyMutation).not.toHaveBeenCalled();
    expect(s.entry("qty")).toBeUndefined();
    // The message is one slot for the whole page. This box never wrote it, so whatever another
    // section put there must still be there: no call at all, not even one that clears.
    expect(s.onError).not.toHaveBeenCalled();
  });

  it("the stored value typed back over a Not saved box settles, and clears the message that box wrote", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "20"); s.blur("qty");
    s.requests[0].fails(BELOW_SHIPPED);
    await flush();
    expect(s.banner()).toBe(BELOW_SHIPPED);
    s.focus("qty"); s.type("qty", "32"); s.blur("qty");
    expect(s.requests).toHaveLength(1);
    expect(s.entry("qty")).toBeUndefined();
    expect(s.view("qty")).toEqual({ text: "32", mark: null, message: null, saving: false });
    // The message still showed this box's own words, and no other box had written since.
    expect(s.banner()).toBeNull();
  });

  it("a blur that changed nothing does nothing at all", () => {
    const s = mounted();
    s.focus("qty"); s.blur("qty");
    expect(s.saves()).toBe(NO_FIELD_SAVES);
    expect(s.applyMutation).not.toHaveBeenCalled();
    expect(s.onError).not.toHaveBeenCalled();
  });
});

describe("focus, blur, Enter and Restore", () => {
  const event = (value: string, key?: string) => ({ key, target: { value }, currentTarget: { value } });

  it("focus records which box it arrived in and the text that box holds", () => {
    const focusedValue = { current: "" };
    const focusedKey: { current: string | null } = { current: null };
    const noteFocus = actual<NoteFocus>("noteFocus", { focusedValue, focusedKey });
    noteFocus("L1:qty", event("32"));
    expect([focusedKey.current, focusedValue.current]).toEqual(["L1:qty", "32"]);
    noteFocus("L1:weight", event("60"));
    expect([focusedKey.current, focusedValue.current]).toEqual(["L1:weight", "60"]);
  });

  it("a blur hands commit the box's text and the text it held at focus, and the box no longer has focus", () => {
    const commit = vi.fn();
    const focusedKey: { current: string | null } = { current: "L1:qty" };
    const focusedValue = { current: "32" };
    actual<FieldHandler>("onBlurField", { focusedValue, focusedKey, fieldKey, commit })(event("40"), LEAD, "qty");
    expect(commit.mock.calls).toEqual([[LEAD, "qty", "40", "32"]]);
    expect(focusedKey.current).toBeNull();
    // The text at focus is left for the next focus to rewrite.
    expect(focusedValue.current).toBe("32");
  });

  it("a blur of one box does not say another box lost focus", () => {
    // The browser reports the blur of the box being left before the focus of the box arrived in.
    // Should the two ever come the other way round, the box arrived in keeps its focus.
    const focusedKey: { current: string | null } = { current: "L1:weight" };
    actual<FieldHandler>("onBlurField", { focusedValue: { current: "60" }, focusedKey, fieldKey, commit: vi.fn() })(event("40"), LEAD, "qty");
    expect(focusedKey.current).toBe("L1:weight");
  });

  it("Enter hands commit the text with no at-focus text, and records it as the text held at focus", () => {
    const commit = vi.fn();
    const focusedValue = { current: "32" };
    actual<FieldHandler>("onEnterField", { focusedValue, commit })(event("40", "Enter"), LEAD, "weight");
    expect(commit.mock.calls).toEqual([[LEAD, "weight", "40", null]]);
    expect(focusedValue.current).toBe("40");
  });

  it("no other key saves or moves the at-focus text", () => {
    const commit = vi.fn();
    const focusedValue = { current: "32" };
    const onEnterField = actual<FieldHandler>("onEnterField", { focusedValue, commit });
    for (const key of ["Tab", "4", "Escape", " "]) onEnterField(event("40", key), LEAD, "qty");
    expect(commit).not.toHaveBeenCalled();
    expect(focusedValue.current).toBe("32");
  });

  it("an Enter save that is refused, then a blur, sends one request; a second Enter sends the retry", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "20"); s.enter("qty");
    s.requests[0].fails(BELOW_SHIPPED);
    await flush();
    s.blur("qty");
    expect(s.requests).toHaveLength(1);
    s.enter("qty");
    expect(s.requests.map((r) => r.init.body)).toEqual(['{"qty":20}', '{"qty":20}']);
    // The retry is out: the box still reads Not saved until it settles.
    expect(s.view("qty")).toEqual({ text: "20", mark: "not-saved", message: BELOW_SHIPPED, saving: true });
    s.requests[1].lands();
    await flush();
    expect(s.view("qty")).toEqual({ text: "20", mark: "saved", message: null, saving: false });
    expect(s.onError.mock.calls).toEqual([[BELOW_SHIPPED], [null]]);
  });

  it("after a refusal the server answered, Restore drops the box's entry and clears the message, with no request", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "20"); s.blur("qty");
    s.requests[0].fails(BELOW_SHIPPED);
    await flush();
    expect(s.banner()).toBe(BELOW_SHIPPED);
    s.focus("qty");
    s.restore("qty");
    expect(s.requests).toHaveLength(1);
    expect(s.applyMutation).toHaveBeenCalledOnce();
    expect(s.entry("qty")).toBeUndefined();
    expect(s.view("qty")).toEqual({ text: "32", mark: null, message: null, saving: false });
    expect(s.banner()).toBeNull();
    // The blur that follows a Restore click sends nothing: the box shows the stored value and
    // holds no entry. Focus never left it, and Restore recorded the stored value as its text at focus.
    expect(s.focused()).toEqual({ key: "L1:qty", text: "32" });
    const restored = s.saves();
    s.blur("qty");
    expect(s.requests).toHaveLength(1);
    expect(s.saves()).toBe(restored);
  });
});

// The section's message is one slot for the whole section, and nothing on it says who wrote it. A
// box that stops reading Not saved with no request (Restore where it clears, or the stored value
// typed back and left) takes its words off only when they are its own: it was the last of the
// section's boxes to write a failure there, and the slot still shows the words it wrote. Where the
// section clears on that condition it hands `onError` a function of the slot's value, so these
// tests read the value (`s.banner()`), never the call. `s.elsewhere` is anything else in the
// section writing the slot.
describe("the section's message is one slot, shared by both boxes and by the rest of the section", () => {
  type Mounted = ReturnType<typeof mounted>;
  const WEIGHT_BELOW = "Lead (ACME · P-A): cannot reduce net weight below 10 lb already shipped";
  /** What the Containers section says of a row it refuses. */
  const ELSEWHERE = "Container 2: Containers must be a whole number of at least 1.";
  const STORED = { qty: "32", weight: "60" } as const;
  const clean = (field: LineField) => ({ text: STORED[field], mark: null, message: null, saving: false });
  /** The two ways a box stops reading Not saved with no request. */
  const PUT_BACK = [
    ["Restore", (s: Mounted, field: LineField) => s.restore(field)],
    ["the stored value typed back and left", (s: Mounted, field: LineField) => {
      s.focus(field); s.type(field, STORED[field]); s.blur(field);
    }],
  ] as const;

  /** A value typed into one box and left, and the server refusing it in these words. */
  async function refusedBox(field: LineField, typedText: string, message: string, s: Mounted = mounted()) {
    const sent = s.requests.length;
    s.focus(field); s.type(field, typedText); s.blur(field);
    s.requests[sent].fails(message);
    await flush();
    return s;
  }
  /** The quantity is refused, then the weight: both boxes read Not saved, and the message shows the
   *  weight's words, the newer of the two. */
  async function bothRefused(qtyMessage: string, weightMessage: string) {
    const s = await refusedBox("qty", "20", qtyMessage);
    expect(s.banner()).toBe(qtyMessage);
    await refusedBox("weight", "5", weightMessage, s);
    expect(s.banner()).toBe(weightMessage);
    expect(s.view("qty")).toEqual({ text: "20", mark: "not-saved", message: qtyMessage, saving: false });
    expect(s.view("weight")).toEqual({ text: "5", mark: "not-saved", message: weightMessage, saving: false });
    return s;
  }

  it.each(PUT_BACK)("two boxes refused, the first put back by %s: the message keeps the second box's words", async (_how, putBack) => {
    const s = await bothRefused(BELOW_SHIPPED, WEIGHT_BELOW);
    putBack(s, "qty");
    expect(s.requests).toHaveLength(2);
    expect(s.entry("qty")).toBeUndefined();
    expect(s.view("qty")).toEqual(clean("qty"));
    // The weight box still reads Not saved, and the message still says why.
    expect(s.view("weight")).toEqual({ text: "5", mark: "not-saved", message: WEIGHT_BELOW, saving: false });
    expect(s.banner()).toBe(WEIGHT_BELOW);
    // The weight box wrote last. Put back in its turn, it takes its words with it.
    putBack(s, "weight");
    expect(s.view("weight")).toEqual(clean("weight"));
    expect(s.banner()).toBeNull();
    expect(s.requests).toHaveLength(2);
  });

  it.each(PUT_BACK)("two boxes refused, the second put back by %s: its words go, and the first box then has none on the message to take", async (_how, putBack) => {
    const s = await bothRefused(BELOW_SHIPPED, WEIGHT_BELOW);
    putBack(s, "weight");
    expect(s.banner()).toBeNull();
    // The quantity is still refused, and says so under its line. The message said the weight's words.
    expect(s.view("qty")).toEqual({ text: "20", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
    s.elsewhere(ELSEWHERE);
    putBack(s, "qty");
    expect(s.view("qty")).toEqual(clean("qty"));
    expect(s.banner()).toBe(ELSEWHERE);
  });

  it.each(PUT_BACK)("one box refused and put back by %s: its words go from the message", async (_how, putBack) => {
    const s = await refusedBox("qty", "20", BELOW_SHIPPED);
    expect(s.banner()).toBe(BELOW_SHIPPED);
    putBack(s, "qty");
    expect(s.view("qty")).toEqual(clean("qty"));
    expect(s.banner()).toBeNull();
    expect(s.requests).toHaveLength(1);
  });

  it.each(PUT_BACK)("one box refused, the message then written from elsewhere, the box put back by %s: the message is left alone", async (_how, putBack) => {
    const s = await refusedBox("qty", "20", BELOW_SHIPPED);
    s.elsewhere(ELSEWHERE);
    putBack(s, "qty");
    expect(s.entry("qty")).toBeUndefined();
    expect(s.view("qty")).toEqual(clean("qty"));
    expect(s.banner()).toBe(ELSEWHERE);
  });

  it.each(PUT_BACK)("two boxes refused in the same words, the first put back by %s: the message stays, because the second box wrote it last", async (_how, putBack) => {
    const s = await bothRefused(CONFLICT, CONFLICT);
    putBack(s, "qty");
    expect(s.view("qty")).toEqual(clean("qty"));
    expect(s.view("weight")).toEqual({ text: "5", mark: "not-saved", message: CONFLICT, saving: false });
    expect(s.banner()).toBe(CONFLICT);
    putBack(s, "weight");
    expect(s.banner()).toBeNull();
  });

  it.each(PUT_BACK)("a box takes the words it wrote, not the words it reads: a typo over a save in flight, the older save then refused, put back by %s", async (_how, putBack) => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.focus("qty"); s.type("qty", "4o"); s.blur("qty");
    s.requests[0].fails(BELOW_SHIPPED);
    await flush();
    // The message keeps the newest thing said about the box, the typo. The box's entry holds the
    // older save's answer, which never reached the message.
    expect(s.banner()).toBe(NOT_WHOLE);
    expect(s.entry("qty")).toEqual({ draft: "4o", pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED } });
    putBack(s, "qty");
    expect(s.view("qty")).toEqual(clean("qty"));
    expect(s.banner()).toBeNull();
  });

  it.each(PUT_BACK)("a save that lands clears the message, and with it the section's claim: the same words from elsewhere afterwards are not the box's to take by %s", async (_how, putBack) => {
    const s = await refusedBox("qty", "40", CONFLICT);
    s.focus("weight"); s.type("weight", "61"); s.blur("weight");
    s.requests[1].lands();
    await flush();
    // A save that lands clears the message whatever it says: the page's convention, kept.
    expect(s.banner()).toBeNull();
    expect(s.owner()).toBeNull();
    // Another section's save meets the same conflict, in the same words.
    s.elsewhere(CONFLICT);
    putBack(s, "qty");
    expect(s.view("qty")).toEqual(clean("qty"));
    expect(s.banner()).toBe(CONFLICT);
  });

  it("records which box wrote the message last and the words, for a refusal the page makes and for one the server makes", async () => {
    const s = mounted();
    expect(s.owner()).toBeNull();
    s.focus("qty"); s.type("qty", "4o"); s.blur("qty");
    expect(s.owner()).toEqual({ key: "L1:qty", message: NOT_WHOLE });
    await refusedBox("weight", "5", WEIGHT_BELOW, s);
    expect(s.owner()).toEqual({ key: "L1:weight", message: WEIGHT_BELOW });
    // A box that takes its words off the message gives up the record too.
    s.restore("weight");
    expect(s.banner()).toBeNull();
    expect(s.owner()).toBeNull();
  });

  it("an attempt that a newer one replaced writes neither the message nor the record when it fails", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "20"); s.blur("qty");
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.requests[0].fails(BELOW_SHIPPED);
    await flush();
    expect(s.banner()).toBeNull();
    expect(s.owner()).toBeNull();
  });

  it("only a box that reads Not saved takes anything off the message: one a payload settled is a clean box, typed into and typed back", async () => {
    const s = await refusedBox("qty", "40", CONFLICT);
    // Another session saved 40. The payload shows the box's own text, so the entry goes. A payload
    // writes no banner, so the box's words are still there.
    s.payload({ qty: 40 });
    expect(s.entry("qty")).toBeUndefined();
    expect(s.banner()).toBe(CONFLICT);
    s.focus("qty"); s.type("qty", "41"); s.type("qty", "40"); s.blur("qty");
    expect(s.requests).toHaveLength(1);
    expect(s.entry("qty")).toBeUndefined();
    expect(s.banner()).toBe(CONFLICT);
  });
});

// A save that got no answer may have been committed, so after one the stored value on the page may
// not be what the server holds. Restore then SAVES that value (owner ruling 2026-10-07), and so
// does the stored value typed back and left (decided without the owner, for the same reason): the
// screen and the order are made to agree by a request, and the box stays Not saved (and the
// section stays registered, so the traveler print waits) until one lands.
describe("a save the server did not answer", () => {
  /** The lead line's box holds a typed value whose save got no answer. */
  async function lost(field: LineField = "qty", typedText = "40") {
    const s = mounted();
    s.focus(field); s.type(field, typedText); s.blur(field);
    s.requests[0].drops();
    await flush();
    return s;
  }
  const bodies = (s: ReturnType<typeof mounted>) => s.requests.map((r) => r.init.body);

  it.each([
    ["qty", "40", '{"qty":40}', '{"qty":32}', "32"],
    ["weight", "48.5", '{"weight":"48.5"}', '{"weight":"60"}', "60"],
  ] as const)("%s: Restore sends exactly one PATCH carrying the stored value, through applyMutation, and the box ends Saved", async (field, typedText, typedBody, storedBody, storedText) => {
    const s = await lost(field, typedText);
    expect(bodies(s)).toEqual([typedBody]);
    expect(s.view(field)).toEqual({ text: typedText, mark: "not-saved", message: NO_ANSWER, saving: false });
    expect(s.entry(field)).toEqual({ draft: typedText, pending: null, outcome: { kind: "failed", message: NO_ANSWER }, unanswered: true });
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER]]);
    s.restore(field);
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1].url).toBe("/api/orders/order-a/lines/L1");
    expect(s.requests[1].init).toEqual({ method: "PATCH", body: storedBody });
    expect(s.order).toEqual(["applyMutation", "api", "applyMutation", "api"]);
    // While it is out: the stored value in the box, still Not saved and still unsaved work, with a
    // save in flight (which is what disables Restore), and the message as it was.
    expect(s.view(field)).toEqual({ text: storedText, mark: "not-saved", message: NO_ANSWER, saving: true });
    expect(s.notSaved()).toBe(true);
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER]]);
    s.requests[1].lands();
    await flush();
    expect(s.view(field)).toEqual({ text: storedText, mark: "saved", message: null, saving: false });
    expect(s.notSaved()).toBe(false);
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [null]]);
    expect(s.requests).toHaveLength(2);
  });

  it.each([500, 502, 503, 504])("a %i is no answer: the box records an unanswered save and Restore saves the stored value", async (status) => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.requests[0].fails(`Request failed (${status})`, status);
    await flush();
    expect(s.entry("qty")).toEqual({
      draft: "40", pending: null, outcome: { kind: "failed", message: `Request failed (${status})` }, unanswered: true,
    });
    s.restore("qty");
    expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}']);
  });

  it.each([400, 401, 403, 404, 409, 422, 499])("a %i is an answer: Restore sends nothing, clears the box and clears the message", async (status) => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "20"); s.blur("qty");
    s.requests[0].fails(BELOW_SHIPPED, status);
    await flush();
    expect(s.view("qty")).toEqual({ text: "20", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
    // Written as it has always been: the entry of a box no save of which went unanswered has no record.
    expect(s.entry("qty")).toEqual({ draft: "20", pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED } });
    expect(s.banner()).toBe(BELOW_SHIPPED);
    s.restore("qty");
    expect(s.requests).toHaveLength(1);
    expect(s.applyMutation).toHaveBeenCalledOnce();
    expect(s.entry("qty")).toBeUndefined();
    expect(s.view("qty")).toEqual({ text: "32", mark: null, message: null, saving: false });
    expect(s.banner()).toBeNull();
  });

  it("an error that is not the fetcher's ApiError is no answer, whatever it is and whatever it carries", async () => {
    // Besides an ApiError, `api()` ends a request that passes no signal, as this one does, with
    // fetch's own rejection, where no response arrived and each browser words it differently
    // (Chromium, Firefox, WebKit, in that order), or, since #547, with `UnreadableAnswerError` (no
    // `status`) for an OK answer whose body could not be read: its write committed, and the owner's
    // 2026-10-18 ruling counts it unanswered.
    const noResponse = [
      new TypeError(NO_ANSWER),
      new TypeError("NetworkError when attempting to fetch resource."),
      new TypeError("Load failed"),
      new UnreadableAnswerError("The change was saved, but the answer could not be read. Reload the page to see it.", { cause: new SyntaxError("x") }),
    ];
    // Not something the request path produces. It is here to prove the class is what is asked,
    // and not a `status` read off whatever was thrown.
    const lookalike = Object.assign(new Error("Bad request"), { status: 400 });
    for (const error of [...noResponse, lookalike]) {
      const s = mounted();
      s.focus("qty"); s.type("qty", "40"); s.blur("qty");
      s.requests[0].rejects(error);
      await flush();
      expect(s.entry("qty")).toEqual({ draft: "40", pending: null, outcome: { kind: "failed", message: error.message }, unanswered: true });
      s.restore("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}']);
    }
  });

  it("a value the client refuses made no request: Restore sends nothing", () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "4o"); s.blur("qty");
    expect(s.entry("qty")).toEqual({ draft: "4o", pending: null, outcome: { kind: "failed", message: NOT_WHOLE } });
    expect(s.banner()).toBe(NOT_WHOLE);
    s.restore("qty");
    expect(s.applyMutation).not.toHaveBeenCalled();
    expect(s.entry("qty")).toBeUndefined();
    expect(s.banner()).toBeNull();
  });

  it("a restore-save that gets no answer either stays Not saved over the stored value, and Restore sends it again", async () => {
    const s = await lost();
    s.restore("qty");
    s.requests[1].fails("Request failed (502)", 502);
    await flush();
    expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: "Request failed (502)", saving: false });
    expect(s.entry("qty")).toEqual({ draft: "32", pending: null, outcome: { kind: "failed", message: "Request failed (502)" }, unanswered: true });
    // The box shows the stored value and the section is still registered: nothing says the server holds it.
    expect(s.notSaved()).toBe(true);
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER], ["Request failed (502)"]]);
    s.restore("qty");
    expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}', '{"qty":32}']);
    s.requests[2].lands();
    await flush();
    expect(s.view("qty")).toEqual({ text: "32", mark: "saved", message: null, saving: false });
    expect(s.notSaved()).toBe(false);
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER], ["Request failed (502)"], [null]]);
  });

  it("after an unanswered restore-save, a payload that shows the stored value settles nothing: the box stays Not saved, and Restore sends again", async () => {
    const s = await lost();
    s.restore("qty");
    s.requests[1].drops();
    await flush();
    const before = s.saves();
    s.payload({ weight: 61 }); // another section's save; the quantity in it is the stored 32
    // The box holds 32 and so does that order, which may still be older than either lost write.
    expect(s.saves()).toBe(before);
    expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: NO_ANSWER, saving: false });
    expect(s.notSaved()).toBe(true);
    s.restore("qty");
    expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}', '{"qty":32}']);
    s.requests[2].lands();
    await flush();
    expect(s.view("qty")).toEqual({ text: "32", mark: "saved", message: null, saving: false });
    expect(s.notSaved()).toBe(false);
  });

  it("after an unanswered restore-save, a payload that shows the typed value leaves the box Not saved, and Restore then saves that value", async () => {
    const s = await lost();
    s.restore("qty");
    s.requests[1].drops();
    await flush();
    s.payload({ qty: 40 }); // the first write did land, and the restore-save did not
    expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: NO_ANSWER, saving: false });
    expect(s.notSaved()).toBe(true);
    // Restore sends what the page holds NOW, which is also the value its control names.
    s.restore("qty");
    expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}', '{"qty":40}']);
    expect(s.view("qty")).toEqual({ text: "40", mark: "not-saved", message: NO_ANSWER, saving: true });
    s.requests[2].lands();
    await flush();
    expect(s.view("qty")).toEqual({ text: "40", mark: "saved", message: null, saving: false });
  });

  it("a payload that shows the typed value settles nothing either: the box stays Not saved until Enter or Restore sends a save that lands", async () => {
    const s = await lost();
    const before = s.saves();
    s.payload({ qty: 40 }); // the write did land, and nothing tells the page this order is newer than it
    expect(s.saves()).toBe(before);
    expect(s.view("qty")).toEqual({ text: "40", mark: "not-saved", message: NO_ANSWER, saving: false });
    expect(s.notSaved()).toBe(true);
    expect(s.requests).toHaveLength(1);
    // Tabbing through sends nothing. Enter sends the 40 the box holds, the stored value by now.
    s.focus("qty"); s.blur("qty");
    expect(s.requests).toHaveLength(1);
    s.focus("qty"); s.enter("qty");
    expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":40}']);
    s.requests[1].lands();
    await flush();
    expect(s.view("qty")).toEqual({ text: "40", mark: "saved", message: null, saving: false });
    expect(s.notSaved()).toBe(false);
    // Restore saves the stored value, which is 40 now.
    const r = await lost();
    r.payload({ qty: 40 });
    r.restore("qty");
    expect(bodies(r)).toEqual(['{"qty":40}', '{"qty":40}']);
    r.requests[1].lands();
    await flush();
    expect(r.view("qty")).toEqual({ text: "40", mark: "saved", message: null, saving: false });
    expect(r.notSaved()).toBe(false);
  });

  it("a restore-save the server refuses reads Not saved with the server's words, and the box keeps its record", async () => {
    const s = await lost();
    s.restore("qty");
    s.requests[1].fails(BELOW_SHIPPED);
    await flush();
    expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
    // The refusal is what the box reads. The record is about the first save, and stays.
    expect(s.entry("qty")).toEqual({ draft: "32", pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED }, unanswered: true });
    expect(s.notSaved()).toBe(true);
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [BELOW_SHIPPED]]);
  });

  it("the stored value typed back over the box and left is sent, not settled", async () => {
    const s = await lost();
    s.focus("qty"); s.type("qty", "32"); s.blur("qty");
    expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}']);
    expect(s.entry("qty")).toEqual({
      draft: "32", pending: { attempt: 2, text: "32" }, outcome: { kind: "failed", message: NO_ANSWER }, unanswered: true,
    });
    // Not settled, so the message is not cleared here: the answer clears it.
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER]]);
    s.requests[1].lands();
    await flush();
    expect(s.view("qty")).toEqual({ text: "32", mark: "saved", message: null, saving: false });
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [null]]);
  });

  it("tabbing through the box sends nothing, and Enter retries the typed value", async () => {
    const s = await lost();
    const before = s.saves();
    s.focus("qty"); s.blur("qty");
    expect(s.requests).toHaveLength(1);
    expect(s.saves()).toBe(before);
    s.enter("qty");
    expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":40}']);
    expect(s.view("qty")).toEqual({ text: "40", mark: "not-saved", message: NO_ANSWER, saving: true });
    s.requests[1].lands();
    await flush();
    expect(s.view("qty")).toEqual({ text: "40", mark: "saved", message: null, saving: false });
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [null]]);
  });

  it("the blur that follows a Restore click sends nothing more, while the restore-save is out or once it has landed", async () => {
    const s = await lost();
    s.focus("qty"); // focus is in the box, holding 40, and the Restore control keeps it there
    s.restore("qty");
    s.blur("qty");
    expect(s.requests).toHaveLength(2);
    s.requests[1].lands();
    await flush();
    s.blur("qty");
    expect(s.requests).toHaveLength(2);
    expect(s.view("qty")).toEqual({ text: "32", mark: "saved", message: null, saving: false });
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [null]]);
  });

  it("when the restore-save got no answer, that blur sends nothing more either: Restore recorded the stored value as the box's text at focus", async () => {
    const s = await lost();
    s.focus("qty"); // at focus the box held 40; Restore changes it to 32 with no focus event
    expect(s.focused()).toEqual({ key: "L1:qty", text: "40" });
    s.restore("qty");
    expect(s.focused()).toEqual({ key: "L1:qty", text: "32" });
    s.requests[1].drops();
    await flush();
    const unansweredState = s.saves();
    s.blur("qty");
    expect(s.requests).toHaveLength(2);
    expect(s.saves()).toBe(unansweredState);
    expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: NO_ANSWER, saving: false });
    expect(s.notSaved()).toBe(true);
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [NO_ANSWER]]);
  });

  it("a Restore of a box that does not have focus moves no text at focus", async () => {
    // From the keyboard: Tab left the box for the Restore control, so no box has focus.
    const s = await lost();
    s.focus("qty"); s.blur("qty"); // tabbed through: nothing sent, and the text at focus was 40
    expect(s.focused()).toEqual({ key: null, text: "40" });
    s.restore("qty");
    expect(s.focused()).toEqual({ key: null, text: "40" });
    // With the pointer, while focus is in the other box of the row.
    const t = await lost();
    t.focus("weight");
    t.restore("qty");
    expect(t.focused()).toEqual({ key: "L1:weight", text: "60" });
  });

  it("a restore-save that a newer save replaced does not write the message when it ends", async () => {
    const s = await lost();
    s.restore("qty");
    s.focus("qty"); s.type("qty", "45"); s.blur("qty");
    expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}', '{"qty":45}']);
    s.requests[1].lands();
    await flush();
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER]]);
    expect(s.view("qty")).toEqual({ text: "45", mark: null, message: null, saving: true });
    s.requests[2].fails(BELOW_SHIPPED);
    await flush();
    expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [BELOW_SHIPPED]]);
  });

  // The record that a save went unanswered belongs to the box, not to its newest failure. Nothing
  // short of a later save of that box landing says what became of the lost write, an order payload
  // included, so nothing else may turn Restore back into a local clear or let the stored value
  // typed back settle with no request.
  describe("the record stays on the box", () => {
    const saved32 = { text: "32", mark: "saved", message: null, saving: false };

    it("a 409 to the restore-save: Restore sends again, never a local clear, and when that save lands the box reads Saved and nothing is registered", async () => {
      const s = await lost();
      s.restore("qty");
      s.requests[1].fails(CONFLICT, 409);
      await flush();
      expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: CONFLICT, saving: false });
      expect(s.notSaved()).toBe(true);
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [CONFLICT]]);
      // "Please try again": the operator does.
      s.restore("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}', '{"qty":32}']);
      expect(s.order).toEqual(["applyMutation", "api", "applyMutation", "api", "applyMutation", "api"]);
      // Nothing was cleared on the way: the box is still marked, the section still registered,
      // and the message still says what the server said.
      expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: CONFLICT, saving: true });
      expect(s.notSaved()).toBe(true);
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [CONFLICT]]);
      s.requests[2].lands();
      await flush();
      expect(s.view("qty")).toEqual(saved32);
      expect(s.entry("qty")).toEqual({ draft: "32", pending: null, outcome: { kind: "saved", text: "32" } });
      expect(s.notSaved()).toBe(false);
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [CONFLICT], [null]]);
      expect(s.requests).toHaveLength(3);
    });

    it.each([400, 401, 403, 404, 409, 422, 499])("a %i to the restore-save is an answer about that request only: the next Restore sends again", async (status) => {
      const s = await lost();
      s.restore("qty");
      s.requests[1].fails(BELOW_SHIPPED, status);
      await flush();
      expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
      expect(s.notSaved()).toBe(true);
      s.restore("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}', '{"qty":32}']);
      expect(s.entry("qty")).toBeDefined();
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [BELOW_SHIPPED]]);
    });

    it.each([
      ["a typo", "4o"],
      ["an emptied box", ""],
    ])("%s the page refuses, then Restore: the stored value is sent", async (_what, slip) => {
      const s = await lost();
      s.focus("qty"); s.type("qty", slip); s.blur("qty");
      // No request was made, so nothing was learned about the server.
      expect(s.requests).toHaveLength(1);
      expect(s.view("qty")).toEqual({ text: slip, mark: "not-saved", message: NOT_WHOLE, saving: false });
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [NOT_WHOLE]]);
      s.restore("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}']);
      expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: NOT_WHOLE, saving: true });
      expect(s.notSaved()).toBe(true);
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [NOT_WHOLE]]);
      s.requests[1].lands();
      await flush();
      expect(s.view("qty")).toEqual(saved32);
      expect(s.notSaved()).toBe(false);
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [NOT_WHOLE], [null]]);
    });

    it("a typo refused on Enter, then the stored value typed back and left: it is sent, not settled", async () => {
      const s = await lost();
      s.focus("qty"); s.type("qty", "4o"); s.enter("qty");
      expect(s.requests).toHaveLength(1);
      s.type("qty", "32"); s.blur("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}']);
      // Not settled: the entry is there and the message was not cleared.
      expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: NOT_WHOLE, saving: true });
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [NOT_WHOLE]]);
    });

    it("an Enter retry refused with a 400, then Restore: the stored value is sent", async () => {
      const s = await lost();
      s.focus("qty"); s.enter("qty");
      s.requests[1].fails(BELOW_SHIPPED, 400);
      await flush();
      expect(s.view("qty")).toEqual({ text: "40", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
      s.restore("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":40}', '{"qty":32}']);
      expect(s.notSaved()).toBe(true);
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [BELOW_SHIPPED]]);
    });

    it("an Enter retry refused with a 400, then the stored value typed back and left: it is sent", async () => {
      const s = await lost();
      s.focus("qty"); s.enter("qty");
      s.requests[1].fails(BELOW_SHIPPED, 400);
      await flush();
      s.type("qty", "32"); s.blur("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":40}', '{"qty":32}']);
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [BELOW_SHIPPED]]);
    });

    it("a key typed while the restore-save is out, the save then refused: the section is registered at every step and Restore still sends", async () => {
      const s = await lost();
      s.focus("qty"); // the pointer went down on Restore with focus in the box, and it stays there
      expect(s.notSaved()).toBe(true);
      s.restore("qty");
      expect(s.notSaved()).toBe(true);
      s.type("qty", "3");
      // The mark is about text that is no longer in the box, so it is not shown while the save is
      // out. The section is registered all the same: the traveler print does not come free for the
      // length of a request.
      expect(s.view("qty")).toEqual({ text: "3", mark: null, message: null, saving: true });
      expect(s.notSaved()).toBe(true);
      s.requests[1].fails("Order not found", 404); // the order was voided since
      await flush();
      expect(s.view("qty")).toEqual({ text: "3", mark: "not-saved", message: "Order not found", saving: false });
      expect(s.notSaved()).toBe(true);
      s.restore("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}', '{"qty":32}']);
      expect(s.notSaved()).toBe(true);
    });

    it("a Restore with focus in the box, the restore-save refused, then a blur: nothing more is sent, and the mark and the server's words stay", async () => {
      const s = await lost();
      s.focus("qty"); // at focus the box held 40
      s.restore("qty"); // the box now holds 32, with no focus event
      s.requests[1].fails(BELOW_SHIPPED);
      await flush();
      const refusedState = s.saves();
      s.blur("qty");
      expect(s.requests).toHaveLength(2);
      expect(s.saves()).toBe(refusedState);
      expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
      expect(s.notSaved()).toBe(true);
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER], [BELOW_SHIPPED]]);
    });

    it("a value typed after such a Restore is compared with what Restore left in the box: the typed value again is sent", async () => {
      const s = await lost();
      s.focus("qty");
      s.restore("qty");
      s.requests[1].drops();
      await flush();
      s.type("qty", "40"); s.blur("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}', '{"qty":40}']);
    });

    it("Restore on one box leaves the other box's text at focus alone", async () => {
      const s = mounted();
      s.focus("weight"); s.type("weight", "5"); s.blur("weight");
      s.requests[0].fails("Lead (ACME · P-A): cannot reduce net weight below 10 lb already shipped");
      await flush();
      s.focus("qty"); s.type("qty", "40"); s.blur("qty");
      s.requests[1].drops();
      await flush();
      s.focus("weight"); // the weight box holds its refused 5 at focus
      s.restore("qty"); // the quantity's Restore, clicked with focus in the weight box
      expect(bodies(s)).toEqual(['{"weight":"5"}', '{"qty":40}', '{"qty":32}']);
      // The weight box still holds what it held at focus: leaving it sends nothing for it.
      s.blur("weight");
      expect(s.requests).toHaveLength(3);
      expect(s.view("weight").mark).toBe("not-saved");
    });

    it("the record goes when a save of the box lands: a refusal after that is an answered one again, and Restore clears", async () => {
      const s = await lost();
      s.focus("qty"); s.enter("qty"); // the retry of 40
      s.requests[1].lands();
      await flush();
      // Gone at the landing itself, before the order its answer carried reaches the section.
      expect(s.entry("qty")).toEqual({ draft: "40", pending: null, outcome: { kind: "saved", text: "40" } });
      expect(s.notSaved()).toBe(false);
      s.payload({ qty: 40 });
      expect(s.entry("qty")).toEqual({ draft: null, pending: null, outcome: { kind: "saved", text: "40" } });
      expect(s.notSaved()).toBe(false);
      s.type("qty", "20"); s.blur("qty");
      s.requests[2].fails(BELOW_SHIPPED);
      await flush();
      s.restore("qty");
      expect(s.requests).toHaveLength(3);
      expect(s.entry("qty")).toBeUndefined();
      expect(s.view("qty")).toEqual({ text: "40", mark: null, message: null, saving: false });
      expect(s.notSaved()).toBe(false);
    });

    it("the record goes when that save lands although the text has moved on since it was sent", async () => {
      const s = await lost();
      s.focus("qty"); s.enter("qty");
      s.type("qty", "45");
      expect(s.notSaved()).toBe(true);
      s.requests[1].lands();
      await flush();
      s.payload({ qty: 40 });
      // The server holds the 40 that was sent; 45 is text being typed, as in any box.
      expect(s.entry("qty")).toEqual({ draft: "45", pending: null, outcome: null });
      expect(s.notSaved()).toBe(false);
    });

    it("a payload alone never takes the record: one that shows another value leaves it, and so does one that shows the box's own text", async () => {
      const s = await lost();
      s.restore("qty");
      s.requests[1].fails(CONFLICT, 409);
      await flush();
      // Another value: it may have been read before the lost write was committed.
      const before = s.saves();
      s.payload({ qty: 35 });
      expect(s.saves()).toBe(before);
      expect(s.notSaved()).toBe(true);
      s.restore("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}', '{"qty":35}']);
      // The box's own text: that order may be older than the lost write too. Nothing goes.
      const t = await lost();
      t.restore("qty");
      t.requests[1].fails(CONFLICT, 409);
      await flush();
      const refusedState = t.saves();
      t.payload({ weight: 61 }); // another section's save; the quantity in it is the 32 the box shows
      expect(t.saves()).toBe(refusedState);
      expect(t.view("qty")).toEqual({ text: "32", mark: "not-saved", message: CONFLICT, saving: false });
      expect(t.notSaved()).toBe(true);
      t.restore("qty");
      expect(bodies(t)).toEqual(['{"qty":40}', '{"qty":32}', '{"qty":32}']);
      // That save landing takes the record. A refusal after it is an answered one again, and
      // Restore clears with no request.
      t.requests[2].lands();
      await flush();
      expect(t.notSaved()).toBe(false);
      t.focus("qty"); t.type("qty", "20"); t.blur("qty");
      t.requests[3].fails(BELOW_SHIPPED);
      await flush();
      t.restore("qty");
      expect(t.requests).toHaveLength(4);
      expect(t.entry("qty")).toBeUndefined();
    });

    it("an older save's order, applied after a newer save of the box was lost, leaves the record: the box reads Not saved over the value it shows, and leaving it sends that value", async () => {
      const s = mounted();
      s.focus("qty"); s.type("qty", "40"); s.enter("qty"); // the first save: 40
      s.type("qty", "32"); s.enter("qty"); // the second: back to 32, sent because 40 is out
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}']);
      s.requests[1].drops(); // the server may hold 32, written after the 40
      await flush();
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER]]);
      s.type("qty", "40");
      // The first save's answer arrives now, and the page applies the order it carries: nothing
      // newer was applied, because a request that fails does not advance the page's gate.
      s.requests[0].lands();
      await flush();
      s.payload({ qty: 40 });
      expect(s.entry("qty")).toEqual({ draft: "40", pending: null, outcome: { kind: "failed", message: NO_ANSWER }, unanswered: true });
      expect(s.view("qty")).toEqual({ text: "40", mark: "not-saved", message: NO_ANSWER, saving: false });
      expect(s.notSaved()).toBe(true);
      // The landing was not the box's newest attempt, so it left the message alone as well.
      expect(s.onError.mock.calls).toEqual([[NO_ANSWER]]);
      // The box holds what the page now shows as stored. It is sent, not settled.
      s.blur("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":32}', '{"qty":40}']);
      s.requests[2].lands();
      await flush();
      expect(s.view("qty")).toEqual({ text: "40", mark: "saved", message: null, saving: false });
      expect(s.notSaved()).toBe(false);
    });
  });

  // Two saves of one box can be out at once, and the box waits on the newer. When the older ends
  // with no answer it may still be what the server holds, so the box records it. The section's message
  // is the newest attempt's to write: the older one says nothing there.
  describe("an older save of the box that a newer one had replaced", () => {
    /** 40 saved with Enter, then 45 typed and left while that save is out. */
    function twoOut() {
      const s = mounted();
      s.focus("qty"); s.type("qty", "40"); s.enter("qty");
      s.type("qty", "45"); s.blur("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":45}']);
      return s;
    }

    it("gets no answer while the newer is out: the box records it, the section is registered, and the message is not written", async () => {
      const s = twoOut();
      expect(s.notSaved()).toBe(false);
      s.requests[0].drops();
      await flush();
      expect(s.entry("qty")).toEqual({ draft: "45", pending: { attempt: 2, text: "45" }, outcome: null, unanswered: true });
      expect(s.view("qty")).toEqual({ text: "45", mark: null, message: null, saving: true });
      expect(s.notSaved()).toBe(true);
      expect(s.onError).not.toHaveBeenCalled();
      expect(s.owner()).toBeNull();
    });

    it("the newer is then refused: the box keeps the record, and Restore saves the stored value where it used to clear", async () => {
      const s = twoOut();
      s.requests[0].drops(); // the server may have written 40
      await flush();
      s.requests[1].fails(BELOW_SHIPPED); // answered: nothing was written for 45
      await flush();
      expect(s.entry("qty")).toEqual({ draft: "45", pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED }, unanswered: true });
      expect(s.onError.mock.calls).toEqual([[BELOW_SHIPPED]]);
      s.restore("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":45}', '{"qty":32}']);
      expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: BELOW_SHIPPED, saving: true });
      expect(s.notSaved()).toBe(true);
      s.requests[2].lands();
      await flush();
      expect(s.view("qty")).toEqual({ text: "32", mark: "saved", message: null, saving: false });
      expect(s.notSaved()).toBe(false);
    });

    it("the newer was refused first: the older getting no answer afterwards sets the record under the refusal's words", async () => {
      const s = twoOut();
      s.requests[1].fails(BELOW_SHIPPED);
      await flush();
      s.requests[0].drops();
      await flush();
      expect(s.entry("qty")).toEqual({ draft: "45", pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED }, unanswered: true });
      // The message still says what the newest attempt said.
      expect(s.onError.mock.calls).toEqual([[BELOW_SHIPPED]]);
      // The stored value typed back and left is sent, where it settled before the record was set.
      s.focus("qty"); s.type("qty", "32"); s.blur("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":45}', '{"qty":32}']);
    });

    it("the newer then lands: the record goes with that landing", async () => {
      const s = twoOut();
      s.requests[0].drops();
      await flush();
      s.requests[1].lands();
      await flush();
      expect(s.entry("qty")).toEqual({ draft: "45", pending: null, outcome: { kind: "saved", text: "45" } });
      expect(s.notSaved()).toBe(false);
      expect(s.onError.mock.calls).toEqual([[null]]);
    });

    it("the newer was refused and restored: the older getting no answer marks the stored value Not saved, with no banner, and Enter or Restore saves it", async () => {
      const refusedRestoredLost = async () => {
        const s = twoOut();
        s.requests[1].fails(BELOW_SHIPPED);
        await flush();
        s.restore("qty"); // nothing had gone unanswered yet: local, and the box's words leave the message
        expect(s.requests).toHaveLength(2);
        expect(s.entry("qty")).toBeUndefined();
        expect(s.banner()).toBeNull();
        s.requests[0].drops();
        await flush();
        expect(s.entry("qty")).toEqual({ draft: null, pending: null, outcome: { kind: "failed", message: NO_ANSWER }, unanswered: true });
        expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: NO_ANSWER, saving: false });
        expect(s.notSaved()).toBe(true);
        // The reason is under the line. The message is the newest attempt's, and stays empty.
        expect(s.banner()).toBeNull();
        expect(s.owner()).toBeNull();
        return s;
      };
      // Tabbing through the box sends nothing; Enter sends the stored value it shows.
      const s = await refusedRestoredLost();
      s.focus("qty"); s.blur("qty");
      expect(s.requests).toHaveLength(2);
      s.focus("qty"); s.enter("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":45}', '{"qty":32}']);
      s.requests[2].lands();
      await flush();
      expect(s.view("qty")).toEqual({ text: "32", mark: "saved", message: null, saving: false });
      expect(s.notSaved()).toBe(false);
      // Restore sends it too.
      const r = await refusedRestoredLost();
      r.restore("qty");
      expect(bodies(r)).toEqual(['{"qty":40}', '{"qty":45}', '{"qty":32}']);
      expect(r.view("qty")).toEqual({ text: "32", mark: "not-saved", message: NO_ANSWER, saving: true });
    });

    // The handlers decide from the save state of the render on screen. The older save's lost
    // answer is not an event: the record it sets can be a render ahead of them for an instant,
    // and a click or a blur in that instant decides without it. The leaf keeps the entry all the
    // same, so what that instant costs is one more click or Enter, never the record.
    it("a Restore clicked before the page has rendered the older save's lost answer does not clear the record: the box shows the stored value, still Not saved, and the next Restore sends", async () => {
      const s = twoOut();
      s.requests[1].fails(BELOW_SHIPPED);
      await flush();
      const onScreen = s.rendered(); // 45 Not saved, and no save of the box known to be unanswered
      s.requests[0].drops();
      await flush();
      onScreen.restore("qty"); // decided from the render on screen: local, and no request
      expect(s.requests).toHaveLength(2);
      expect(s.entry("qty")).toEqual({ draft: null, pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED }, unanswered: true });
      expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
      expect(s.notSaved()).toBe(true);
      s.restore("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":45}', '{"qty":32}']);
    });

    it("the stored value typed back and left in that instant is not settled away either: Enter then sends it", async () => {
      const s = twoOut();
      s.requests[1].fails(BELOW_SHIPPED);
      await flush();
      s.focus("qty"); s.type("qty", "32");
      const onScreen = s.rendered();
      s.requests[0].drops();
      await flush();
      onScreen.blur("qty", "32"); // decided from the render on screen: settled, and no request
      expect(s.requests).toHaveLength(2);
      expect(s.entry("qty")).toEqual({ draft: null, pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED }, unanswered: true });
      expect(s.view("qty")).toEqual({ text: "32", mark: "not-saved", message: BELOW_SHIPPED, saving: false });
      expect(s.notSaved()).toBe(true);
      s.focus("qty"); s.enter("qty");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"qty":45}', '{"qty":32}']);
    });
  });

  // A box no save of which went unanswered is as it was before any of this.
  describe("a box no save of which went unanswered", () => {
    /** A refusal the server answered, then a typo the page refused, then another server refusal. */
    async function refusedTypoRefused() {
      const s = mounted();
      s.focus("qty"); s.type("qty", "20"); s.blur("qty");
      s.requests[0].fails(BELOW_SHIPPED);
      await flush();
      s.focus("qty"); s.type("qty", "2o"); s.blur("qty");
      s.focus("qty"); s.type("qty", "21"); s.blur("qty");
      s.requests[1].fails(BELOW_SHIPPED, 409);
      await flush();
      expect(s.entry("qty")).toEqual({ draft: "21", pending: null, outcome: { kind: "failed", message: BELOW_SHIPPED } });
      return s;
    }

    it("after a refusal, a typo and another refusal, Restore clears the box and the message and sends nothing", async () => {
      const s = await refusedTypoRefused();
      expect(s.banner()).toBe(BELOW_SHIPPED);
      s.restore("qty");
      expect(s.requests).toHaveLength(2);
      expect(s.entry("qty")).toBeUndefined();
      expect(s.view("qty")).toEqual({ text: "32", mark: null, message: null, saving: false });
      expect(s.notSaved()).toBe(false);
      expect(s.banner()).toBeNull();
    });

    it("from the same state, the stored value typed back and left settles with no request", async () => {
      const s = await refusedTypoRefused();
      expect(s.banner()).toBe(BELOW_SHIPPED);
      s.focus("qty"); s.type("qty", "32"); s.blur("qty");
      expect(s.requests).toHaveLength(2);
      expect(s.entry("qty")).toBeUndefined();
      expect(s.notSaved()).toBe(false);
      expect(s.banner()).toBeNull();
    });

    it("a key typed while a retry of a refused value is out: the section is not registered for that moment, as before", async () => {
      const s = mounted();
      s.focus("qty"); s.type("qty", "20"); s.enter("qty");
      s.requests[0].fails(BELOW_SHIPPED);
      await flush();
      s.enter("qty");
      s.type("qty", "2");
      expect(s.view("qty")).toEqual({ text: "2", mark: null, message: null, saving: true });
      expect(s.notSaved()).toBe(false);
    });
  });
});

describe("the offered weight", () => {
  it("a quantity save that lands marks its line for an offer", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    // Nothing is offered while the save is out: the stored quantity has not changed yet.
    expect(s.offered()).toEqual([]);
    s.requests[0].lands();
    await flush();
    expect(s.offered()).toEqual(["L1"]);
  });

  it("a quantity save that fails marks nothing", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "20"); s.blur("qty");
    const before = s.offerLines();
    s.requests[0].fails(BELOW_SHIPPED);
    await flush();
    expect(s.offerLines()).toBe(before);
    // Nor does a value the client refuses, or one that settles without a request.
    s.focus("qty"); s.type("qty", "4o"); s.blur("qty");
    s.focus("qty"); s.type("qty", "32"); s.blur("qty");
    expect(s.offerLines()).toBe(before);
  });

  it("a weight save that lands by hand takes the offer away: the weight is the operator's own now", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.requests[0].lands();
    await flush();
    s.focus("weight"); s.type("weight", "55"); s.blur("weight");
    expect(s.offered()).toEqual(["L1"]); // still offered while the weight save is out
    s.requests[1].lands();
    await flush();
    expect(s.offered()).toEqual([]);
  });

  it("a weight save that fails leaves the offer", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.requests[0].lands();
    await flush();
    const before = s.offerLines();
    s.focus("weight"); s.type("weight", "5"); s.blur("weight");
    s.requests[1].fails("Lead (ACME · P-A): cannot reduce net weight below 10 lb already shipped");
    await flush();
    expect(s.offerLines()).toBe(before);
  });

  it("an accepted offer is one weight save through commit, and landing takes the offer away", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.requests[0].lands();
    await flush();
    s.use(48);
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1].url).toBe("/api/orders/order-a/lines/L1");
    expect(s.requests[1].init).toEqual({ method: "PATCH", body: '{"weight":"48"}' });
    // The figure is in the weight box while the save is out, and a second click sends nothing more.
    expect(s.view("weight")).toEqual({ text: "48", mark: null, message: null, saving: true });
    s.use(48);
    expect(s.requests).toHaveLength(2);
    s.requests[1].lands();
    await flush();
    expect(s.view("weight")).toEqual({ text: "48", mark: "saved", message: null, saving: false });
    expect(s.offered()).toEqual([]);
  });

  it("an accepted offer that gets no answer reads Not saved at the weight box, stays offered, and the next click retries", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.requests[0].lands();
    await flush();
    s.use(48);
    s.requests[1].drops();
    await flush();
    expect(s.view("weight")).toEqual({ text: "48", mark: "not-saved", message: NO_ANSWER, saving: false });
    expect(s.offered()).toEqual(["L1"]);
    s.use(48);
    expect(s.requests.map((r) => r.init.body)).toEqual(['{"qty":40}', '{"weight":"48"}', '{"weight":"48"}']);
    s.requests[2].lands();
    await flush();
    expect(s.view("weight")).toEqual({ text: "48", mark: "saved", message: null, saving: false });
    expect(s.offered()).toEqual([]);
  });

  // The pointer's Use leaves focus where it was (WeightOfferNote prevents the pointer-down), so
  // when that is the line's weight box, the box's text changes to the figure with no focus event.
  // The handler records the figure as that box's text at focus, as Restore records the stored
  // value: a Not saved figure is then not sent again by leaving the box.
  describe("accepted with focus in the line's weight box", () => {
    const WEIGHT_BELOW = "Lead (ACME · P-A): cannot reduce net weight below 50 lb already shipped";
    /** The quantity saved, so the line is offered a weight; then focus in the weight box. */
    async function offeredWithFocusInWeight() {
      const s = mounted();
      s.focus("qty"); s.type("qty", "40"); s.blur("qty");
      s.requests[0].lands();
      await flush();
      s.focus("weight"); // at focus the box holds the stored 60
      expect(s.focused()).toEqual({ key: "L1:weight", text: "60" });
      return s;
    }
    const bodies = (s: ReturnType<typeof mounted>) => s.requests.map((r) => r.init.body);

    it("a figure the server refuses is sent once: the blur that follows sends nothing more, and the box stays Not saved", async () => {
      const s = await offeredWithFocusInWeight();
      s.use(48);
      expect(s.focused()).toEqual({ key: "L1:weight", text: "48" });
      s.requests[1].fails(WEIGHT_BELOW);
      await flush();
      const refusedState = s.saves();
      s.blur("weight");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"weight":"48"}']);
      expect(s.saves()).toBe(refusedState);
      expect(s.view("weight")).toEqual({ text: "48", mark: "not-saved", message: WEIGHT_BELOW, saving: false });
      expect(s.onError.mock.calls).toEqual([[null], [WEIGHT_BELOW]]);
      // Use again is the retry, as Enter is.
      s.use(48);
      expect(bodies(s)).toEqual(['{"qty":40}', '{"weight":"48"}', '{"weight":"48"}']);
    });

    it("the same when the figure got no answer, and with other text typed into the box before Use", async () => {
      const s = await offeredWithFocusInWeight();
      s.type("weight", "999"); // never sent: the figure replaces it
      s.use(48);
      s.requests[1].drops();
      await flush();
      const lostState = s.saves();
      s.blur("weight");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"weight":"48"}']);
      expect(s.saves()).toBe(lostState);
      expect(s.view("weight")).toEqual({ text: "48", mark: "not-saved", message: NO_ANSWER, saving: false });
    });

    it("a weight typed after the refused figure is compared with the figure, not with what the box held when focus arrived", async () => {
      const s = await offeredWithFocusInWeight();
      s.use(48);
      s.requests[1].fails(WEIGHT_BELOW);
      await flush();
      s.type("weight", "55"); s.blur("weight");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"weight":"48"}', '{"weight":"55"}']);
      // The stored 60 is what the box held when focus arrived, and it is a change from the figure:
      // typed back and left, it settles, where a blur judged against 60 would have skipped it.
      const t = await offeredWithFocusInWeight();
      t.use(48);
      t.requests[1].fails(WEIGHT_BELOW);
      await flush();
      t.type("weight", "60"); t.blur("weight");
      expect(t.requests).toHaveLength(2);
      expect(t.entry("weight")).toBeUndefined();
      expect(t.view("weight")).toEqual({ text: "60", mark: null, message: null, saving: false });
    });

    it("a figure that lands leaves nothing for the blur to send either", async () => {
      const s = await offeredWithFocusInWeight();
      s.use(48);
      s.requests[1].lands();
      await flush();
      s.blur("weight");
      expect(bodies(s)).toEqual(['{"qty":40}', '{"weight":"48"}']);
      expect(s.view("weight")).toEqual({ text: "48", mark: "saved", message: null, saving: false });
    });
  });

  it("accepted with focus in another box, or in none: that box's text at focus is not moved", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.enter("qty"); // Enter keeps focus in the quantity box
    s.requests[0].lands();
    await flush();
    expect(s.focused()).toEqual({ key: "L1:qty", text: "40" });
    s.use(48);
    expect(s.focused()).toEqual({ key: "L1:qty", text: "40" });
    s.requests[1].fails("Lead (ACME · P-A): cannot reduce net weight below 50 lb already shipped");
    await flush();
    // The quantity box still holds what it held at focus: leaving it sends nothing for it.
    s.blur("qty");
    expect(s.requests).toHaveLength(2);
    expect(s.focused()).toEqual({ key: null, text: "40" });
    s.use(48);
    expect(s.focused()).toEqual({ key: null, text: "40" });
  });

  describe("acceptOffer", () => {
    const WEIGHT_KEY = fieldKey(LEAD.id, "weight");
    /** The handler alone, over the section's two focus refs and a stand-in for commit that notes
     *  the text at focus as it finds it when it is called. */
    function accepting(focusOn: string | null, atFocus: string) {
      const focusedKey: { current: string | null } = { current: focusOn };
      const focusedValue = { current: atFocus };
      const atFocusWhenSent: string[] = [];
      const commit = vi.fn();
      commit.mockImplementation(() => { atFocusWhenSent.push(focusedValue.current); });
      const acceptOffer = actual<AcceptOffer>("acceptOffer", { focusedValue, focusedKey, fieldKey, commit });
      return { acceptOffer, commit, focusedKey, focusedValue, atFocusWhenSent };
    }

    it("hands commit the line, its weight box, the figure as plain text, and no text at focus", () => {
      const a = accepting(null, "32");
      a.acceptOffer(LEAD, 48);
      a.acceptOffer(RIDER, 12.5);
      expect(a.commit.mock.calls).toEqual([[LEAD, "weight", "48", null], [RIDER, "weight", "12.5", null]]);
    });

    it("with focus in that line's weight box, records the figure as the box's text at focus before it sends", () => {
      const a = accepting(WEIGHT_KEY, "999");
      a.acceptOffer(LEAD, 48);
      expect(a.focusedValue.current).toBe("48");
      expect(a.focusedKey.current).toBe(WEIGHT_KEY);
      // Recorded first, as Restore records the stored value: commit already finds it there.
      expect(a.atFocusWhenSent).toEqual(["48"]);
    });

    it("with focus in any other box, or in none, leaves the text at focus alone", () => {
      for (const elsewhere of [null, fieldKey(LEAD.id, "qty"), fieldKey(RIDER.id, "weight"), fieldKey(RIDER.id, "qty")]) {
        const a = accepting(elsewhere, "32");
        a.acceptOffer(LEAD, 48);
        expect([a.focusedKey.current, a.focusedValue.current]).toEqual([elsewhere, "32"]);
        expect(a.atFocusWhenSent).toEqual(["32"]);
      }
    });
  });

  it("a Restore that saves a quantity is a quantity save: landing marks its line, failing marks nothing", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.requests[0].drops();
    await flush();
    const before = s.offerLines();
    s.restore("qty");
    s.requests[1].drops();
    await flush();
    expect(s.offerLines()).toBe(before);
    s.restore("qty");
    expect(s.offered()).toEqual([]);
    s.requests[2].lands();
    await flush();
    expect(s.offered()).toEqual(["L1"]);
  });

  it("a Restore that saves a weight is a weight save: landing takes the offer away", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.requests[0].lands();
    await flush();
    s.focus("weight"); s.type("weight", "55"); s.blur("weight");
    s.requests[1].drops();
    await flush();
    expect(s.offered()).toEqual(["L1"]);
    s.restore("weight");
    expect(s.requests[2].init).toEqual({ method: "PATCH", body: '{"weight":"60"}' });
    expect(s.offered()).toEqual(["L1"]); // still offered while the restore-save is out
    s.requests[2].lands();
    await flush();
    expect(s.offered()).toEqual([]);
  });

  it("a quantity save that a newer one replaced still marks its line when it lands: the stored quantity did change", async () => {
    const s = mounted();
    s.focus("qty"); s.type("qty", "40"); s.blur("qty");
    s.focus("qty"); s.type("qty", "20"); s.blur("qty");
    s.requests[1].fails(BELOW_SHIPPED);
    await flush();
    expect(s.offered()).toEqual([]);
    s.requests[0].lands();
    await flush();
    expect(s.offered()).toEqual(["L1"]);
  });

  describe("offerLinesAfter", () => {
    const none: ReadonlySet<string> = new Set();
    const one: ReadonlySet<string> = new Set(["L1"]);

    it("a quantity save adds its line and a weight save removes it", () => {
      expect([...offerLinesAfter(none, "L1", "qty")]).toEqual(["L1"]);
      expect([...offerLinesAfter(one, "L2", "qty")]).toEqual(["L1", "L2"]);
      expect([...offerLinesAfter(new Set(["L1", "L2"]), "L1", "weight")]).toEqual(["L2"]);
    });

    it("returns the same Set when nothing changes", () => {
      expect(offerLinesAfter(one, "L1", "qty")).toBe(one);
      expect(offerLinesAfter(one, "L2", "weight")).toBe(one);
      expect(offerLinesAfter(none, "L1", "weight")).toBe(none);
    });

    it("never writes into the Set it was given", () => {
      const ids = new Set(["L1"]);
      offerLinesAfter(ids, "L2", "qty");
      offerLinesAfter(ids, "L1", "weight");
      expect([...ids]).toEqual(["L1"]);
    });

    it("a line that is gone is dropped by the leaf's intersection, which the lines effect runs", () => {
      const marked = offerLinesAfter(offerLinesAfter(none, "L1", "qty"), "L2", "qty");
      expect([...retained(marked, ["L2", "L3"])]).toEqual(["L2"]);
      expect(retained(marked, ["L1", "L2"])).toBe(marked);
    });
  });
});

describe("fieldMessage", () => {
  const fieldMessage = actual<(line: Line, field: LineField, view: FieldView) => string | null>(
    "fieldMessage", { checkLineField, lineLabel });
  const notSaved = (viewText: string, message: string): FieldView => ({ text: viewText, mark: "not-saved", message, saving: false });

  it("says nothing for a box that is not marked Not saved, whatever text it holds", () => {
    // Text the client would refuse, still being typed: no mark yet, so no message yet.
    expect(fieldMessage(LEAD, "qty", { text: "4o", mark: null, message: null, saving: false })).toBeNull();
    expect(fieldMessage(LEAD, "weight", { text: "", mark: null, message: null, saving: true })).toBeNull();
  });

  it("shows a server refusal as it came", () => {
    expect(fieldMessage(LEAD, "qty", notSaved("20", BELOW_SHIPPED))).toBe(BELOW_SHIPPED);
  });

  it("words a client-side refusal from the text in the box, for the line as it is numbered now", () => {
    // Refused as Line 3; an earlier rider was removed since, so this line is Line 2 now.
    const renumbered: Line = { id: "L3", position: 2, qty: 5, weight: 9 };
    expect(fieldMessage(renumbered, "qty", notSaved("0", "Line 3: quantity must be a whole number of at least 1.")))
      .toBe("Line 2: quantity must be a whole number of at least 1.");
    expect(fieldMessage(renumbered, "weight", notSaved("0", "Line 3, Net weight (lb): must be greater than zero.")))
      .toBe("Line 2, Net weight (lb): must be greater than zero.");
  });
});

// A refused Enter save, then the blur that follows it, when the save rewrote the spelling in the box.
// Enter records the box's raw text as the text it held at focus; `commit` then shows the spelling the
// request carried ("020" is sent, and shown, as 20; " 20" and "20.0" too; a weight is shown trimmed).
// The blur reads the rewritten text against the raw one, so it must compare values, not spellings:
// the box still holds the value it held when Enter was pressed, and Enter is the retry, not the blur.
describe("a blur after a refused Enter save, when the save rewrote the box's spelling", () => {
  it.each([
    ["qty", "020", '{"qty":20}', "20"],
    ["qty", " 20", '{"qty":20}', "20"],
    ["qty", "20.0", '{"qty":20}', "20"],
    ["weight", "48.5 ", '{"weight":"48.5"}', "48.5"],
  ] as const)("%s typed as %j: the blur sends nothing more, and Enter still retries", async (field, typedText, body, shown) => {
    const s = mounted();
    s.focus(field); s.type(field, typedText); s.enter(field);
    expect(s.requests.map((r) => r.init.body)).toEqual([body]);
    s.requests[0].fails(BELOW_SHIPPED);
    await flush();
    // The refused value is in the box as the request carried it, and the box reads Not saved.
    expect(s.view(field)).toEqual({ text: shown, mark: "not-saved", message: BELOW_SHIPPED, saving: false });
    const refusedState = s.saves();
    s.blur(field);
    expect(s.requests).toHaveLength(1);
    expect(s.applyMutation).toHaveBeenCalledOnce();
    expect(s.saves()).toBe(refusedState);
    expect(s.onError.mock.calls).toEqual([[BELOW_SHIPPED]]);
    // Enter, with no text held at focus, is the retry.
    s.enter(field);
    expect(s.requests.map((r) => r.init.body)).toEqual([body, body]);
  });
});

// Add rider's own checks, made before any request. `addRider` reads no box: it reads the strip's
// state as the render holds it, so each case hands it that state. It is lifted by name like the
// handlers above, and every name it reads is handed to it in `strip()`.
describe("addRider", () => {
  type Strip = {
    adding: boolean; addPartId: string | null; addQty: string;
    /** Text typed into the weight box, or null while the box shows the calculated weight. */
    addWeightOverride: string | null;
    /** Quantity × the part's each weight, or null when there is none to calculate. */
    computedAddWeight: number | null;
  };
  /** The strip with a part picked, 5 typed as the quantity and 10 calculated as the weight. */
  function strip(over: Partial<Strip> = {}) {
    const onError = vi.fn();
    const api = vi.fn(async () => ({}));
    const applyMutation = vi.fn(async (run: () => Promise<unknown>) => { await run(); });
    const set = vi.fn();
    const state: Strip = { adding: false, addPartId: "part-b", addQty: "5", addWeightOverride: null, computedAddWeight: 10, ...over };
    const addRider = actual<() => Promise<void>>("addRider", {
      ...state, addQuotePick: undefined, orderId: "order-a", onError, api, applyMutation, decimalRefusal, LINE_NET_WEIGHT,
      setAdding: set, setAddPartId: set, setAddQty: set, setAddWeightOverride: set, setAddQuotePick: set,
    });
    return { addRider, onError, api };
  }

  const WEIGHT_ZERO = "New line, Net weight (lb): must be greater than zero.";
  const QTY = "New line: enter a quantity of at least 1.";

  it.each([
    ["0 typed", { addWeightOverride: "0" }, WEIGHT_ZERO],
    ["a weight under zero typed", { addWeightOverride: "-1" }, WEIGHT_ZERO],
    ["text that is no number typed", { addWeightOverride: "4o" }, "New line, Net weight (lb): enter a number without $ or commas, such as 0.36."],
    ["the box emptied", { addWeightOverride: "" }, WEIGHT_ZERO],
    ["nothing typed and no weight calculated", { computedAddWeight: null }, WEIGHT_ZERO],
    ["three digits after the point typed", { addWeightOverride: "1.005" }, "New line, Net weight (lb): use at most 2 digits after the point."],
  ] as const)("refuses a net weight that is not a figure over zero, names the box, and sends nothing: %s", async (_what, over, sentence) => {
    const s = strip(over);
    await s.addRider();
    expect(s.onError.mock.calls).toEqual([[sentence]]);
    expect(s.api).not.toHaveBeenCalled();
  });

  it("a quantity refused alone is one line, in its existing words", async () => {
    const s = strip({ addQty: "0" });
    await s.addRider();
    expect(s.onError.mock.calls).toEqual([[QTY]]);
    expect(s.api).not.toHaveBeenCalled();
  });

  it("a quantity and a weight both refused are listed together, the quantity's first", async () => {
    const s = strip({ addQty: "0", addWeightOverride: "0" });
    await s.addRider();
    expect(s.onError.mock.calls).toEqual([[`${QTY}\n${WEIGHT_ZERO}`]]);
    expect(s.api).not.toHaveBeenCalled();
  });

  it("no part picked is refused alone and first: nothing else is checked", async () => {
    const s = strip({ addPartId: null, addQty: "0", addWeightOverride: "0" });
    await s.addRider();
    expect(s.onError.mock.calls).toEqual([["Pick a part to add as a rider."]]);
    expect(s.api).not.toHaveBeenCalled();
  });

  it.each([
    ["typed", { addWeightOverride: " 12.5 " }, '{"partId":"part-b","qty":5,"weight":"12.5"}'],
    ["calculated", {}, '{"partId":"part-b","qty":5,"weight":"10"}'],
  ] as const)("a net weight over zero, %s, is sent, and the message is cleared", async (_how, over, body) => {
    const s = strip(over);
    await s.addRider();
    expect(s.api.mock.calls).toEqual([["/api/orders/order-a/lines", { method: "POST", body }]]);
    expect(s.onError.mock.calls).toEqual([[null]]);
  });
});

// Remove, run against the real removal leaf (#475). `removeLine` is lifted by name like the handlers
// above, with the record of marks held in a local Set and changed through `setRemovals` the way
// React applies each updater, and every request held open until the test answers it. The page's
// read is a held promise too: `readAfterRemoval` stands for the callback page.tsx hands the
// section, which is pinned above. A payload is the section's own `[lines]` effect, lifted out of
// the source and run over the lines that payload lists.
describe("a removal the server did not answer (#475)", () => {
  /** The rider as the Remove confirm and the messages name it. */
  const ROW = { ...RIDER, part: { customer: { code: "ACME" }, partNumber: "P-B" } };
  const NAMING = "ACME · P-B (Line 2)";
  const CHANGE_LINE = invoiceFreezeSentence(INVOICE_FREEZE.changeLine, { invoiceId: "inv-1", orderNumber: 1031 });

  /** The section's one `[lines]` effect, as its source has it. */
  const linesEffect = (() => {
    const effects = callsTo(section, "useEffect").filter((effect) => callsTo(effect, "reconciled").length > 0);
    expect(effects).toHaveLength(1);
    return ts.transpileModule(`return (${effects[0].arguments[0].getText(source)});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
  })();

  function removal(marked: readonly string[] = []) {
    let marks: UnconfirmedRemovals = marked.length === 0 ? NO_UNCONFIRMED_REMOVALS : new Set(marked);
    const setRemovals = (update: (cur: UnconfirmedRemovals) => UnconfirmedRemovals) => { marks = update(marks); };
    let banner: string | null = null;
    const onError = vi.fn((write: BannerWrite) => { banner = typeof write === "function" ? write(banner) : write; });
    const requests: Request[] = [];
    const api = vi.fn((url: string, init: Request["init"]) => new Promise((resolve, reject) => {
      requests.push({
        url, init,
        lands: () => resolve({}),
        fails: (message, status = 400) => reject(new ApiError(message, status)),
        drops: (message = NO_ANSWER) => reject(new TypeError(message)),
        rejects: (error) => reject(error),
      });
    }));
    const applyMutation = vi.fn(async (run: () => Promise<unknown>) => { await run(); });
    /** The page's reads after a Remove, each held until the test answers it. */
    const reads: Array<{ lands: () => void; fails: (error: unknown) => void }> = [];
    const readAfterRemoval = vi.fn(() => new Promise<void>((resolve, reject) => { reads.push({ lands: resolve, fails: reject }); }));
    const askConfirm = vi.fn<(q: object) => Promise<boolean>>(async () => true);
    const removeLine = actual<(line: typeof ROW) => Promise<void>>("removeLine", {
      orderId: "order-a", serialsScope, unsavedPresentInScope: () => false, getBrowserDraftSession: () => null,
      askConfirm, api, applyMutation, onError, lineLabel, ApiError, unansweredStatus, removalProvesGone,
      removalUnanswered, setRemovals, readAfterRemoval, alreadyRemovedMessage, removedNotRefreshedMessage,
    });
    /** The order on the page now. */
    let lines: Line[] = [LEAD, RIDER];
    return {
      onError, requests, reads, readAfterRemoval, askConfirm, api,
      marks: () => marks,
      banner: () => banner,
      /** A click on the rider's Remove. */
      remove: () => removeLine(ROW),
      /** A fresh order from anywhere, listing these lines: the section's `[lines]` effect runs. */
      payload: (listed: Line[]) => {
        lines = listed;
        const environment = {
          lines, setSaves: () => {}, setOfferLines: () => {}, setRemovals, reconciled, serverValues, retained, removalsListed,
        };
        (new Function(...Object.keys(environment), linesEffect)(...Object.values(environment)) as () => void)();
      },
      /** What the section registers as unsaved work over this state: the argument its
       *  `useUnsavedSection` call is pinned to above, with no box holding anything. */
      registered: () => anyNotSaved(NO_FIELD_SAVES, serverValues(lines)) || anyRemovalUnconfirmed(marks, lines),
    };
  }

  it("a Remove that got no answer marks its line, says so on the message in the browser's words, and reads nothing", async () => {
    const h = removal();
    const done = h.remove();
    await flush();
    expect(h.askConfirm).toHaveBeenCalledExactlyOnceWith({ title: `Remove ${NAMING} from this order?`, body: "", confirm: "Remove line", danger: true });
    expect(h.requests.map((r) => [r.url, r.init])).toEqual([["/api/orders/order-a/lines/L2", { method: "DELETE" }]]);
    h.requests[0].drops();
    await done;
    expect([...h.marks()]).toEqual(["L2"]);
    expect(h.banner()).toBe(NO_ANSWER);
    expect(h.readAfterRemoval).not.toHaveBeenCalled();
    expect(h.registered()).toBe(true);
  });

  it.each([500, 502, 504])("a Remove answered %i marks its line", async (status) => {
    const h = removal();
    const done = h.remove();
    await flush();
    h.requests[0].fails("Internal Server Error", status);
    await done;
    expect([...h.marks()]).toEqual(["L2"]);
    expect(h.banner()).toBe("Internal Server Error");
    expect(h.readAfterRemoval).not.toHaveBeenCalled();
  });

  it.each([
    ["the invoice's refusal", 400, CHANGE_LINE],
    ["the lead rule", 400, "The lead part cannot be removed — void the order instead"],
    ["the order's conflict", 409, CONFLICT],
    ["a voided order", 404, "Order not found"],
    ["a 404 that is not the app's", 404, "Request failed (404)"],
    ["the line's sentence under another status", 400, LINE_NOT_FOUND],
  ] as const)("a Remove answered with %s marks nothing, ends no mark, shows the answer and reads nothing", async (_what, status, message) => {
    for (const marked of [[], ["L2"]]) {
      const h = removal(marked);
      const before = h.marks();
      const done = h.remove();
      await flush();
      h.requests[0].fails(message, status);
      await done;
      expect(h.marks()).toBe(before);
      expect(h.banner()).toBe(message);
      expect(h.readAfterRemoval).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["a first Remove", []],
    ["a retry of a marked line", ["L2"]],
  ] as const)("%s answered 404 'Order line not found' reads the order once and says the line had already gone", async (_what, marked) => {
    const h = removal(marked);
    const before = h.marks();
    const done = h.remove();
    await flush();
    h.requests[0].fails(LINE_NOT_FOUND, 404);
    await flush();
    expect(h.readAfterRemoval).toHaveBeenCalledOnce();
    // Nothing is written while the read is out, and the server's own sentence never is.
    expect(h.onError).not.toHaveBeenCalled();
    h.reads[0].lands();
    await done;
    expect(h.onError.mock.calls).toEqual([[`${NAMING} had already been removed from this order.`]]);
    // The marks are the payload's to end, not the answer's.
    expect(h.marks()).toBe(before);
  });

  it("a read that fails says the line is gone and the page was not refreshed, and the mark stays", async () => {
    const h = removal(["L2"]);
    const before = h.marks();
    const done = h.remove();
    await flush();
    h.requests[0].fails(LINE_NOT_FOUND, 404);
    await flush();
    h.reads[0].fails(new TypeError(NO_ANSWER));
    // The read's failure is the handler's to report: the click's promise resolves.
    await expect(done).resolves.toBeUndefined();
    expect(h.onError.mock.calls).toEqual([[
      `${NAMING} is no longer on this order, but the page could not be refreshed — reload to see the current state. (${NO_ANSWER})`,
    ]]);
    expect(h.marks()).toBe(before);
    expect(h.registered()).toBe(true);
  });

  it("a Remove that lands clears the message, reads nothing, and leaves the mark to the payload", async () => {
    const h = removal(["L2"]);
    const before = h.marks();
    const done = h.remove();
    await flush();
    h.requests[0].lands();
    await done;
    expect(h.onError.mock.calls).toEqual([[null]]);
    expect(h.marks()).toBe(before);
    expect(h.readAfterRemoval).not.toHaveBeenCalled();
  });

  it("a retry with no answer leaves the line marked once: the same record", async () => {
    const h = removal(["L2"]);
    const before = h.marks();
    const done = h.remove();
    await flush();
    h.requests[0].drops();
    await done;
    expect(h.marks()).toBe(before);
  });

  it("a declined confirm on a marked line sends nothing and keeps the mark", async () => {
    const h = removal(["L2"]);
    const before = h.marks();
    h.askConfirm.mockResolvedValueOnce(false);
    await h.remove();
    expect(h.api).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.marks()).toBe(before);
  });

  it("a payload that still lists the line ends nothing (R18); one that no longer lists it ends the mark", () => {
    const h = removal(["L2"]);
    const before = h.marks();
    h.payload([LEAD, { ...RIDER, qty: 6 }]);
    expect(h.marks()).toBe(before);
    expect(h.registered()).toBe(true);
    h.payload([LEAD]);
    expect([...h.marks()]).toEqual([]);
    expect(h.registered()).toBe(false);
  });

  it("from a lost DELETE to a retry answered 'Order line not found': marked, read, and gone with the read's payload", async () => {
    const h = removal();
    const first = h.remove();
    await flush();
    h.requests[0].drops();
    await first;
    expect(h.registered()).toBe(true);
    const retry = h.remove();
    await flush();
    h.requests[1].fails(LINE_NOT_FOUND, 404);
    await flush();
    expect(h.registered()).toBe(true); // the answer ends nothing
    // The read's payload reaches the section as its `lines`.
    h.payload([LEAD]);
    h.reads[0].lands();
    await retry;
    expect(h.registered()).toBe(false);
    expect(h.banner()).toBe(`${NAMING} had already been removed from this order.`);
  });
});
