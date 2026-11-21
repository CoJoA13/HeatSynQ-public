import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { ReportTotals, TotalsReport } from "@/lib/shipment-totals";
import { useTotalsReport } from "@/lib/use-totals-report";
import { declared, jsxTags, mentions } from "./helpers/jsx-source";
import { all } from "./helpers/source-lift";

// How a saved shipment's totals tables are wired (the weights design §12.2 and §12.7, point 8).
// Each order panel's Lines and Containers grids hand their typed rows up through `useTotalsReport`.
// The page keeps the reports and makes one call of `shipmentTotals`. Each panel draws its own
// table, and the page draws Shipment totals.
//
// vitest has no DOM: no test renders ShipmentDetail.tsx whole, and a static render runs no effect.
// So this file runs the hook's own function with `useEffect` replaced by a recorder and plays
// React's part by hand, and it reads the panel's and the page's source through the parser, against
// lists written out here. Nothing here has React run an effect: that it runs this one as this file
// plays it, and runs it twice on a `next dev` mount, is the browser flows' to show.

const SOP = "src/app/shipping/[id]/ShipmentOrderPanel.tsx";
const SD = "src/app/shipping/[id]/ShipmentDetail.tsx";

// ---- the hook, with this file in React's place ----

type Cleanup = (() => void) | undefined;
type Effect = () => void | (() => void);
type Recorded = { effect: Effect; dependencies: readonly unknown[] };
const react = vi.hoisted(() => ({ recorded: [] as Recorded[] }));
// `useEffect` alone is replaced: it keeps what it was handed and runs nothing. Every other export
// of React is the real one, so a hook that calls `useRef` here, outside a render, throws.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: Effect, dependencies: readonly unknown[]) => { react.recorded.push({ effect, dependencies }); },
}));

/** What a grid of the panel does at each render: it calls the hook, once. Named as a component,
 *  which is where the lint rule for hooks lets a hook be called. `mount` calls it as a function.
 *  The key is "so-1" unless a render says otherwise. */
function Grid({ report, value, orderKey = "so-1" }: { report: ReportTotals; value: TotalsReport; orderKey?: string }): null {
  useTotalsReport(report, orderKey, value);
  return null;
}

/** One mounted `Grid`, with this file in React's place, by the rules React documents for an effect:
 *  it runs after the first render, and after a later render whose dependency list differs from the
 *  last one's in some entry (`Object.is`); its cleanup runs before that later run and at unmount;
 *  and on a mount in development every cleanup and then every effect runs once more. */
function mount(report: ReportTotals) {
  let live: (Recorded & { cleanup: Cleanup })[] = [];
  const ran = (effect: Effect): Cleanup => { const cleanup = effect(); return typeof cleanup === "function" ? cleanup : undefined; };
  const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((entry, at) => Object.is(entry, b[at]));
  return {
    render(value: TotalsReport, orderKey?: string): void {
      react.recorded = [];
      Grid({ report, value, orderKey });
      const calls = react.recorded;
      const again = calls.map((call, at) => live[at] === undefined || !same(live[at].dependencies, call.dependencies));
      again.forEach((yes, at) => { if (yes) live[at]?.cleanup?.(); });
      live = calls.map((call, at) => (again[at] ? { ...call, cleanup: ran(call.effect) } : live[at]));
    },
    secondRunOfAMountInDevelopment(): void {
      for (const held of live) held.cleanup?.();
      for (const held of live) held.cleanup = ran(held.effect);
    },
    unmount(): void {
      for (const held of live) held.cleanup?.();
      live = [];
    },
  };
}

const lines = (lineWeights: (number | string)[], unsaved: boolean): TotalsReport => ({ part: "lines", value: { lineWeights, unsaved } });
/** A kept line of 4 lb and one row whose weight box reads 2.50. */
const SAVED = lines([4, "2.50"], false);
const NO_LINES: TotalsReport = { part: "lines", value: null };

describe("useTotalsReport, with this file in React's place", () => {
  it("reports after the first render, and not again for a render that builds an equal value", () => {
    const report = vi.fn<ReportTotals>();
    const grid = mount(report);
    grid.render(SAVED);
    // A new object and a new list, the same content: what a grid builds at every render.
    grid.render(lines([4, "2.50"], false));
    expect(report.mock.calls).toEqual([["so-1", SAVED]]);
  });

  it("a change of one character takes the old report away and gives the new one, in that order", () => {
    const report = vi.fn<ReportTotals>();
    const grid = mount(report);
    grid.render(SAVED);
    grid.render(lines([4, "2.5"], true));
    expect(report.mock.calls).toEqual([["so-1", SAVED], ["so-1", NO_LINES], ["so-1", lines([4, "2.5"], true)]]);
  });

  it("reports again when its effect is run a second time, as on a mount in development", () => {
    const report = vi.fn<ReportTotals>();
    const grid = mount(report);
    grid.render(SAVED);
    grid.secondRunOfAMountInDevelopment();
    // The cleanup took the report away, so the page holds one only because the second run gave it.
    expect(report.mock.calls).toEqual([["so-1", SAVED], ["so-1", NO_LINES], ["so-1", SAVED]]);
  });

  it("takes its report away at unmount, by its own part", () => {
    const report = vi.fn<ReportTotals>();
    const typed: TotalsReport = { part: "containers", value: { containers: [{ count: "3", tareEach: "42.5" }], unsaved: true } };
    const grid = mount(report);
    grid.render(typed);
    grid.unmount();
    expect(report.mock.calls).toEqual([["so-1", typed], ["so-1", { part: "containers", value: null }]]);
  });

  // No case above changes the reporter or the key between renders, so none of them fails when one
  // of the two leaves the list. This one reads the list the hook hands `useEffect`.
  it("hands its effect three dependencies: the reporter, the key and one string", () => {
    const report = vi.fn<ReportTotals>();
    react.recorded = [];
    Grid({ report, value: SAVED });
    expect(react.recorded.map((call) => call.dependencies)).toEqual([[report, "so-1", expect.any(String)]]);
  });

  // The one case that plays a change of key: the same reporter and an equal value, under a second key.
  it("a render under a second key takes the first key's part away and gives the report under the second", () => {
    const report = vi.fn<ReportTotals>();
    const grid = mount(report);
    grid.render(SAVED);
    grid.render(lines([4, "2.50"], false), "so-2");
    expect(report.mock.calls).toEqual([["so-1", SAVED], ["so-1", NO_LINES], ["so-2", SAVED]]);
  });
});

// ---- the panel and the page, read from their source ----

/** One file under `erp/`, parsed with its parent nodes set. */
function parse(file: string): ts.SourceFile {
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
/** Source on one line: every run of white space as one space. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The one function `name` of a parsed file. */
function componentOf(source: ts.SourceFile, name: string): ts.FunctionDeclaration & { body: ts.Block } {
  const found = all(source, ts.isFunctionDeclaration).filter((fn) => fn.name?.text === name);
  if (found.length !== 1 || !found[0].body) throw new Error(`Expected one function ${name}, found ${found.length}`);
  return found[0] as ts.FunctionDeclaration & { body: ts.Block };
}

/** The statements written directly in the body of the one function `name` of `file`, each on one
 *  line. A statement inside a nested function or a block is not among them. */
function statementsOf(file: string, name: string): string[] {
  const source = parse(file);
  return componentOf(source, name).body.statements.map((statement) => oneLine(statement.getText(source)));
}

/** The props the one component `name` of `file` declares, in order, from its parameter's own type:
 *  `name` for one it must be handed, `name?` for one it may be. */
function propsOf(file: string, name: string): string[] {
  const source = parse(file);
  const type = componentOf(source, name).parameters[0]?.type;
  if (!type || !ts.isTypeLiteralNode(type)) throw new Error(`${name} must type its props where it takes them`);
  return type.members.filter(ts.isPropertySignature).map((member) => `${member.name.getText(source)}${member.questionToken ? "?" : ""}`);
}

/** What the one `<name />` of `file` is drawn inside, innermost first, out to the `return` that
 *  draws it: an element by its tag's name, a condition by its left side and its operator. A
 *  parenthesis and the braces of a JSX expression are passed over. It throws on anything else, the
 *  callback of a `map` included, and unless the file holds exactly one such element. */
function enclosing(file: string, name: string): string[] {
  const source = parse(file);
  const found = all(source, (node): node is ts.JsxSelfClosingElement =>
    ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === name);
  if (found.length !== 1) throw new Error(`Expected one <${name} /> in ${file}, found ${found.length}`);
  const out: string[] = [];
  for (let node: ts.Node = found[0].parent; !ts.isReturnStatement(node); node = node.parent) {
    if (ts.isJsxElement(node)) out.push(node.openingElement.tagName.getText(source));
    else if (ts.isJsxSelfClosingElement(node)) out.push(node.tagName.getText(source));
    else if (ts.isBinaryExpression(node)) out.push(`${node.left.getText(source)} ${node.operatorToken.getText(source)}`);
    else if (ts.isConditionalExpression(node)) out.push(`${node.condition.getText(source)} ?`);
    // A tab's panel (PR 4): the `panels` object's property, its fragment and the attribute it rides in.
    else if (ts.isPropertyAssignment(node)) out.push(`${node.name.getText(source)}:`);
    else if (!ts.isParenthesizedExpression(node) && !ts.isJsxExpression(node) && !ts.isJsxFragment(node)
      && !ts.isObjectLiteralExpression(node) && !ts.isJsxAttribute(node) && !ts.isJsxAttributes(node)) {
      throw new Error(`<${name} /> in ${file} is drawn inside a ${ts.SyntaxKind[node.kind]}, which this reader does not read`);
    }
  }
  return out;
}

describe("ShipmentOrderPanel: what each grid hands up, and the table it draws", () => {
  const LINES = 'useTotalsReport(onTotalsReport, shipperOrderId, { part: "lines", value: linesReport(baseline !== undefined, releasedLines, rows, grid.dirty) });';
  const CONTAINERS = 'useTotalsReport(onTotalsReport, shipperOrderId, { part: "containers", value: containersReport(baseline !== undefined, rows, grid.dirty) });';

  // A statement of the component itself, so it runs at every render. The Serials grid feeds no table.
  it.each([["LinesGrid", [LINES]], ["ContainersGrid", [CONTAINERS]], ["SerialsGrid", []]])(
    "%s: the report statements of its own body", (grid, statements) => {
      expect(statementsOf(SOP, grid).filter((statement) => statement.startsWith("useTotalsReport("))).toEqual(statements);
    });

  it("the hook is written three times in the file: its import and those two calls", () => {
    expect(mentions(SOP, "useTotalsReport")).toBe(3);
  });

  it("the panel must be handed its table and the reporter, and hands the reporter to the Lines and Containers grids alone", () => {
    expect(propsOf(SOP, "ShipmentOrderPanel").filter((prop) => /^(?:totals|onTotalsReport)\??$/.test(prop))).toEqual(["totals", "onTotalsReport"]);
    const grids = jsxTags(SOP).filter((tag) => ["LinesGrid", "ContainersGrid", "SerialsGrid"].includes(tag.name));
    expect(grids.map((tag) => [tag.name, tag.attr("onTotalsReport")])).toEqual([
      ["LinesGrid", "onTotalsReport"], ["ContainersGrid", "onTotalsReport"], ["SerialsGrid", undefined],
    ]);
  });

  it("the panel draws its table on no condition, between the Containers grid and the rule above Serials", () => {
    // Directly in the panel's section: no gate and no condition is written round it.
    expect(enclosing(SOP, "ShipmentTotalsTable")).toEqual(["section"]);
    const names = jsxTags(SOP).map((tag) => tag.name);
    const at = names.indexOf("ShipmentTotalsTable");
    expect(names.slice(at - 1, at + 3)).toEqual(["ContainersGrid", "ShipmentTotalsTable", "div", "SerialsGrid"]);
  });

  it("the panel reads its table nowhere else: no gate and no print", () => {
    // Where its props are taken, where they are typed, and as the name and the value of the one
    // attribute that hands it to the table.
    expect(mentions(SOP, "totals")).toBe(4);
  });
});

describe("ShipmentDetail: one call feeds every table", () => {
  it("keeps the reports through one callback that never changes, and nothing else writes them", () => {
    // No dependency: every grid's effect depends on this callback, so one that changed when the
    // reports change would run each effect again, which changes the reports again.
    expect(declared(SD, "onTotalsReport").map(oneLine)).toEqual([
      "useCallback((orderKey: string, report: TotalsReport) => { setReports((held) => withReport(held, orderKey, report)); }, [])",
    ]);
    // Written twice in the whole file: where it is declared, and in that callback.
    expect(mentions(SD, "setReports")).toBe(2);
  });

  it("works every table out in one call, over the saved orders and the reports", () => {
    expect(declared(SD, "totals")).toEqual(["shipmentTotals(savedShipmentTotalsInput(shipper.orders, reports))"]);
  });

  it("hands each panel its own order's table and the reporter", () => {
    const panels = jsxTags(SD).filter((tag) => tag.name === "ShipmentOrderPanel");
    expect(panels.map((tag) => [tag.attr("totals"), tag.attr("onTotalsReport")])).toEqual([["totals.orders[i]", "onTotalsReport"]]);
  });

  it("draws Shipment totals in a block of its own between the panels and Documents, on the one condition that there is a table", () => {
    expect(jsxTags(SD).filter((tag) => tag.name === "ShipmentTotalsTable").map((tag) => tag.attr("totals"))).toEqual(["totals.shipment"]);
    // A block, the one condition, the Orders & quantities panel of the tabs (PR 4), and the page's
    // root through the tabs' column. No gate is written beside the condition, so the table shows
    // on a voided, a reversed and an invoiced shipment.
    expect(enclosing(SD, "ShipmentTotalsTable")).toEqual(["section", "totals.shipment !== null &&", "orders:", "RecordTabs", "div", "div", "div"]);
    const names = jsxTags(SD).map((tag) => tag.name);
    const at = names.indexOf("ShipmentTotalsTable");
    // The block holds the table and no other element, so no heading and no link; the next thing
    // drawn is the Header & freight panel's section and its heading.
    expect(names.slice(at - 2, at + 4)).toEqual(["ShipmentOrderPanel", "section", "ShipmentTotalsTable", "section", "h2", "div"]);
  });

  it("reads the totals and the reports nowhere else: no gate, no save and no print", () => {
    // `totals`: declared, read for a panel's table, read twice for the shipment's (the condition
    // and the table), three times more for the At a glance card's net, tare and gross (PR 4), and
    // written twice as the name of the prop it is handed through.
    expect(mentions(SD, "totals")).toBe(9);
    // `reports`: declared, and read by the one call.
    expect(mentions(SD, "reports")).toBe(2);
  });
});
