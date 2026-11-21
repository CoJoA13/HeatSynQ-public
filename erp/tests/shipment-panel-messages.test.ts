import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { PanelMessage } from "@/app/shipping/[id]/ShipmentOrderPanel";
import { removeOrderUnsavedSentence } from "@/lib/shipment-gates";
import { shipmentOrderScope } from "@/lib/unsaved-guard";
import { jsxTags } from "./helpers/jsx-source";

// Where an order panel's messages are written on the saved shipment page (issue #472, owner ruling
// R-Q3: in the panel only). Each grid keeps its own message and shows it under its own Save row.
// Remove order's message shows in the panel heading. Nothing from a panel reaches the banner at the
// top of the page.
//
// vitest has no DOM, so no click runs here. Three things stand in for one:
//  - `PanelMessage` is rendered on its own;
//  - the two files are read as syntax trees, to prove which state each message is written to and
//    where that state is shown (the lines-section-wiring precedent);
//  - the page's real `removeOrder` is lifted out of its file and run with a reporter (the
//    shipment-order-retained-scope precedent, which runs it with none).
// That each grid's real `save` reports through a free name `onError` is proven by
// remaining-bulk-callbacks.test.ts, which this change must leave green. Only a browser proves a
// click. The flow `discard-grid-edits` drives one of them: the Lines grid's own validation
// refusal, shown in its panel and cleared by that grid's Discard. No flow drives the Containers or
// Serials grid's message, a server's refusal of a grid save, or a refused Remove order's message
// in the heading.

const SOP = "src/app/shipping/[id]/ShipmentOrderPanel.tsx";
const SD = "src/app/shipping/[id]/ShipmentDetail.tsx";
function parse(path: string): ts.SourceFile {
  const file = fileURLToPath(new URL(`../${path}`, import.meta.url));
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const sop = parse(SOP);
const sd = parse(SD);

function all<T extends ts.Node>(root: ts.Node, is: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const walk = (node: ts.Node): void => { if (is(node)) out.push(node); ts.forEachChild(node, walk); };
  walk(root);
  return out;
}
function component(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === name);
  if (found.length !== 1 || !found[0].body) throw new Error(`Expected one function ${name}, found ${found.length}`);
  return found[0];
}
/** The names a component destructures from its props. */
function propNames(fn: ts.FunctionDeclaration): string[] {
  const pattern = fn.parameters[0]?.name;
  if (!pattern || !ts.isObjectBindingPattern(pattern)) throw new Error(`${fn.name?.text} must destructure its props`);
  return pattern.elements.map((e) => e.name.getText());
}
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
const isOpening = (n: ts.Node): n is Opening => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n);
/** The elements named in `names` inside one component, in source order. A `PanelMessage` reads as
 *  `PanelMessage:<its message expression>`. `jsxTags` reads a whole file; this reads one component,
 *  which is the question here: three grids in one file each hold a state of the same name. */
function shown(root: ts.Node, names: readonly string[]): string[] {
  return all(root, isOpening).filter((el) => names.includes(el.tagName.getText())).map((el) => {
    const message = el.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === "message");
    const value = message && ts.isJsxAttribute(message) && message.initializer && ts.isJsxExpression(message.initializer)
      ? message.initializer.expression?.getText() : undefined;
    return value === undefined ? el.tagName.getText() : `${el.tagName.getText()}:${value}`;
  });
}

describe("PanelMessage", () => {
  it("renders nothing while there is no message", () => {
    expect(renderToStaticMarkup(createElement(PanelMessage, { message: null }))).toBe("");
  });

  it("renders a message as an alert that keeps its line breaks, so a list of refusals reads one per line", () => {
    expect(renderToStaticMarkup(createElement(PanelMessage, { message: "Refused for a reason." })))
      .toBe('<p role="alert" class="mt-1 whitespace-pre-line text-sm text-red-700">Refused for a reason.</p>');
    expect(renderToStaticMarkup(createElement(PanelMessage, { message: "First.\nSecond." })))
      .toBe('<p role="alert" class="mt-1 whitespace-pre-line text-sm text-red-700">First.\nSecond.</p>');
  });
});

const GRIDS = [
  ["LinesGrid", "LinesGridView"], ["ContainersGrid", "ContainersGridView"], ["SerialsGrid", "SerialsGridView"],
] as const;

describe("each grid keeps its own message", () => {
  it.each(GRIDS)("%s holds it in its own state, and the name its save reports through is that state's setter", (grid) => {
    const fn = component(sop, grid);
    // The first statement, so the state exists whichever way the component returns. The setter is
    // named `onError` because `save` and Discard already report through that name.
    expect(fn.body!.statements[0].getText()).toBe("const [saveMessage, onError] = useState<string | null>(null);");
    // Not a prop any more: a prop of that name would be the page's banner again.
    expect(propNames(fn)).not.toContain("onError");
    const save = all(fn, ts.isFunctionDeclaration).filter((f) => f.name?.text === "save");
    expect(save).toHaveLength(1);
    const reports = all(save[0], ts.isCallExpression).filter((c) => ts.isIdentifier(c.expression) && c.expression.text === "onError");
    expect(reports.length).toBeGreaterThanOrEqual(2);
  });

  it.each(GRIDS)("%s shows it once, after its own view", (grid, view) => {
    expect(shown(component(sop, grid), [view, "PanelMessage"])).toEqual([view, "PanelMessage:saveMessage"]);
  });

  it("each grid's Discard clears that grid's message", () => {
    expect(jsxTags(SOP).filter((t) => t.name === "SaveButton").map((t) => t.attr("onDiscard")))
      .toEqual(Array(3).fill("() => { grid.discard(); onError(null); }"));
  });

  // The controller's ruling of 2026-10-08: the message also goes when the grid has no unsaved
  // edits left, by whatever route. When that is, is grid-message.ts's to decide and
  // tests/grid-message.test.tsx's to prove. This proves each grid asks, about itself.
  it.each(GRIDS)("%s clears its message when it comes to rest: it asks once, with its own grid's flags and its own message's setter", (grid) => {
    const fn = component(sop, grid);
    const statements = fn.body!.statements.map((s) => s.getText());
    // A statement of the component itself, so it runs on every render, written after the grid it reads.
    const made = statements.findIndex((s) => s.startsWith("const grid = useBulkGrid("));
    expect(made).toBeGreaterThan(-1);
    expect(statements.indexOf("useMessageClearedAtRest(gridAtRest(grid.dirty, grid.canEdit), onError);")).toBeGreaterThan(made);
    const asks = all(fn, ts.isCallExpression).filter((c) => ts.isIdentifier(c.expression) && c.expression.text === "useMessageClearedAtRest");
    expect(asks).toHaveLength(1);
  });
});

describe("the panel heading keeps Remove order's message", () => {
  const panel = component(sop, "ShipmentOrderPanel");

  it("holds it in the panel's own state and hands that state's setter to the page as the reporter", () => {
    const state = all(panel, ts.isVariableDeclaration).filter((d) => d.name.getText() === "[removeMessage, setRemoveMessage]");
    expect(state).toHaveLength(1);
    expect(state[0].initializer?.getText()).toBe("useState<string | null>(null)");
    const buttons = jsxTags(SOP).filter((t) => t.name === "RemoveOrderButton");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].attr("gate")).toBe("removeGate");
    expect(buttons[0].attr("onClick")).toBe("() => onRemove(setRemoveMessage)");
  });

  it("shows it once, under the button and above the grids", () => {
    expect(shown(panel, ["RemoveOrderButton", "PanelMessage", "LinesGrid"]))
      .toEqual(["RemoveOrderButton", "PanelMessage:removeMessage", "LinesGrid"]);
  });

  it("takes no page reporter and hands none down", () => {
    expect(propNames(panel)).not.toContain("onError");
    expect(jsxTags(SOP).filter((t) => t.attr("onError") !== undefined).map((t) => t.name)).toEqual([]);
  });
});

describe("the page hands each panel a way to report, and not its own banner", () => {
  it("passes Remove order's reporter through to removeOrder and passes no onError", () => {
    const panels = jsxTags(SD).filter((t) => t.name === "ShipmentOrderPanel");
    expect(panels).toHaveLength(1);
    expect(panels[0].attr("onRemove")).toBe("(report) => void removeOrder(so.id, so.label, report)");
    expect(panels[0].attr("onError")).toBeUndefined();
  });
});

// ---- the page's real removeOrder, run with a reporter ----

type Report = (message: string | null) => void;
function scenario(options: { unsaved?: boolean; refuse?: string } = {}) {
  const setError = vi.fn();
  const report = vi.fn();
  const askConfirm = vi.fn(async () => true); // Remove order asks through the modal (PR 4)
  const api = vi.fn(async () => { if (options.refuse) throw new Error(options.refuse); return { ok: true }; });
  const applyMutation = vi.fn(async (run: () => Promise<unknown>) => { await run(); });
  // Exactly the free names shipment-order-retained-scope.test.ts supplies. A new free name in
  // `removeOrder` is a ReferenceError here and there.
  const environment: Record<string, unknown> = {
    id: "ship-a", shipmentOrderScope, unsavedPresentInScope: () => options.unsaved ?? false,
    getBrowserDraftSession: () => null, askConfirm, api, setError, applyMutation,
  };
  const code = ts.transpileModule(`return (${component(sd, "removeOrder").getText()});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const removeOrder = new Function(...Object.keys(environment), code)(...Object.values(environment)) as
    (shipperOrderId: string, label: string, report?: Report) => Promise<void>;
  return { removeOrder, setError, report, askConfirm, api };
}

describe("removeOrder reports where it is told to", () => {
  it("unsaved grids in that panel: the reporter gets the refusal, the page banner gets nothing", async () => {
    const h = scenario({ unsaved: true });
    await h.removeOrder("so-a", "101", h.report);
    expect(h.report).toHaveBeenCalledExactlyOnceWith(removeOrderUnsavedSentence("101"));
    expect(h.setError).not.toHaveBeenCalled();
    expect(h.askConfirm).not.toHaveBeenCalled();
    expect(h.api).not.toHaveBeenCalled();
  });

  it("a refusal from the server: the reporter gets the server's words", async () => {
    const h = scenario({ refuse: "Refused by the server." });
    await h.removeOrder("so-a", "101", h.report);
    expect(h.api).toHaveBeenCalledExactlyOnceWith("/api/shippers/ship-a/orders/so-a", { method: "DELETE" });
    expect(h.report).toHaveBeenCalledExactlyOnceWith("Refused by the server.");
    expect(h.setError).not.toHaveBeenCalled();
  });

  it("a removal that goes through: the reporter is cleared, and the page banner is left as it was", async () => {
    const h = scenario();
    await h.removeOrder("so-a", "101", h.report);
    expect(h.api).toHaveBeenCalledOnce();
    expect(h.report).toHaveBeenCalledExactlyOnceWith(null);
    expect(h.setError).not.toHaveBeenCalled();
  });
});
