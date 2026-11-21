// The Containers grid both shipment screens draw (the weights design §12.2): `ContainersGridView`
// in src/app/shipping/ShipmentGrids.tsx.
//
// vitest has no DOM, so the view is read three ways. Its markup is a static render. A static render
// fires no handler, so what the Tare each box writes is its `onChange` read from the source and
// run, and what Add and Add all remaining put on the grid is `addPicked` and `addAllRemaining`
// lifted out of the view and run over the leaf's own prefill (tests/helpers/source-lift.ts). A
// lifted function that gains a free name must gain it in the environment given here, in the same
// change, or it is a ReferenceError.
//
// The saved page's gates on the box are shipment-grid-titles.test.tsx's, and the prefill's own
// values are shipment-container-rows.test.ts's. The classes held here are the ones built on the
// owner's answers of 2026-10-11 to the two browser looks: `table-fixed` and the six column shares
// on the table, on a row's two boxes their width classes and their cells' right padding, and
// `break-words` on a row's Type cell and its Cust Cont Id cell.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContainersGridView, type ContainerCandidate, type ContainerInfo, type ContainerRow, type KeptContainerInfo } from "../src/app/shipping/ShipmentGrids";
import type { Gate } from "../src/lib/permission-ui";
import { prefillContainerRow } from "../src/lib/shipment-container-rows";
import { declared, jsxTags } from "./helpers/jsx-source";
import { headingRowsOf } from "./helpers/markup";
import { all, run } from "./helpers/source-lift";

const VIEW = "src/app/shipping/ShipmentGrids.tsx";
const FORM = "src/app/shipping/new/NewShipment.tsx";
const OPEN: Gate = { allowed: true, disabled: false, title: undefined };
const INFO = new Map<string, ContainerInfo>([
  ["oc-1", { typeName: "Steel Basket", customerContainerId: "BIN-0007" }],
  ["oc-2", { typeName: "Bin", customerContainerId: "" }],
]);
/** A row of the grid: 3 Steel Baskets at 42.5 lb each. */
const row = (over: Partial<ContainerRow> = {}): ContainerRow =>
  ({ key: "sc-1", isNew: false, orderContainerId: "oc-1", count: "3", tareEach: "42.5", ...over });
function view(rows: ContainerRow[]): string {
  return renderToStaticMarkup(<ContainersGridView rows={rows} candidates={[]} infoById={INFO} gate={OPEN}
    onPatch={() => {}} onRemove={() => {}} onAddRows={() => {}} />);
}
/** Every body row of the grid's table, cell by cell. A cell that holds a box reads
 *  `<the box's spoken name>=<its text>`. Any other cell reads its text. */
function bodyRows(html: string): string[][] {
  const body = /<tbody>(.*?)<\/tbody>/.exec(html);
  expect(body, "the grid's table").not.toBeNull();
  return (body![1].match(/<tr\b.*?<\/tr>/g) ?? []).map((tr) =>
    [...tr.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map(([, cell]) => {
      const box = /<input\b[^>]*>/.exec(cell)?.[0];
      if (box === undefined) return cell.replace(/<[^>]+>/g, "");
      return `${/\saria-label="([^"]*)"/.exec(box)?.[1]}=${/\svalue="([^"]*)"/.exec(box)?.[1]}`;
    }));
}
/** The class names an opening tag carries, in the order written. */
const classesOf = (tag: string): string[] => (/\sclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(" ").filter(Boolean);
/** The third and fourth cells of each body row of the grid's table, which hold the number of
 *  containers and the tare each: the cell's own `pr-` classes, and the `w-` and `max-w-` classes of
 *  the box the cell holds, or null where it holds none. */
function boxCells(html: string): { padding: string[]; box: string[] | null }[][] {
  const body = /<tbody>(.*?)<\/tbody>/.exec(html)?.[1] ?? "";
  return (body.match(/<tr\b.*?<\/tr>/g) ?? []).map((tr) =>
    [...tr.matchAll(/(<td\b[^>]*>)(.*?)<\/td>/g)].slice(2, 4).map(([, td, cell]) => {
      const box = /<input\b[^>]*>/.exec(cell)?.[0];
      return { padding: classesOf(td).filter((name) => name.startsWith("pr-")), box: box === undefined ? null : classesOf(box).filter((name) => /^(max-)?w-/.test(name)) };
    }));
}
/** For each body row of the grid's table, the heading over each cell that carries `break-words`. */
function wrappingCells(html: string): string[][] {
  const [headings] = headingRowsOf(html);
  const body = /<tbody>(.*?)<\/tbody>/.exec(html)?.[1] ?? "";
  return (body.match(/<tr\b.*?<\/tr>/g) ?? []).map((tr) =>
    [...tr.matchAll(/<td\b[^>]*>/g)].flatMap(([td], at) => (classesOf(td).includes("break-words") ? [headings[at]] : [])));
}
function parsed(file: string): ts.SourceFile {
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const functionsNamed = (root: ts.Node, name: string) => all(root, ts.isFunctionDeclaration).filter((fn) => fn.name?.text === name);

describe("the Containers grid: what it draws", () => {
  it("heads its columns Type, Cust Cont Id, Containers, Tare each (lb), Tare total (lb) and an empty one", () => {
    expect(headingRowsOf(view([row()]))).toEqual([["Type", "Cust Cont Id", "Containers", "Tare each (lb)", "Tare total (lb)", ""]]);
  });

  it("draws each row's type, its Cust Cont Id or a dash, its two boxes by name with their text, its tare total and Remove", () => {
    expect(bodyRows(view([row(), row({ key: "new-1", isNew: true, orderContainerId: "oc-2", count: "14", tareEach: "310" })]))).toEqual([
      ["Steel Basket", "BIN-0007", "Container 1 count=3", "Container 1 tare each=42.5", "127.50", "Remove"],
      ["Bin", "—", "Container 2 count=14", "Container 2 tare each=310", "4,340.00", "Remove"],
    ]);
  });

  it.each([
    ["a tare each of 0", { tareEach: "0" }, "0.00"],
    ["a blank Tare each box", { tareEach: "" }, "—"],
    ["a half typed tare each", { tareEach: "42." }, "—"],
    ["a number of containers typed 3.0", { count: "3.0" }, "—"],
  ])("the Tare total cell for %s", (_state, over, cell) => {
    expect(bodyRows(view([row(over)]))[0][4]).toBe(cell);
  });
});

describe("the Containers grid: its two boxes", () => {
  it("names both from the row's label, which the leaf gives", () => {
    expect(declared(VIEW, "labels")).toEqual(["containerLabels(rows)"]);
    expect(jsxTags(VIEW).filter((tag) => tag.name === "input").map((tag) => tag.attr("aria-label")).filter((name) => name?.includes("labels[i]")))
      .toEqual(["`${labels[i]} count`", "`${labels[i]} tare each`"]);
  });

  it("the Tare each box patches its own row's tareEach with the text as typed", () => {
    // A box that is not found, or has no `onChange`, runs as `undefined` and the call below throws.
    const [onChange] = jsxTags(VIEW).filter((tag) => tag.name === "input" && tag.attr("aria-label") === "`${labels[i]} tare each`")
      .map((tag) => tag.attr("onChange"));
    const typed = row();
    const patched: unknown[][] = [];
    run<(event: { target: { value: string } }) => void>(onChange ?? "undefined",
      { onPatch: (...args: unknown[]) => { patched.push(args); }, row: typed })({ target: { value: " 42.50 " } });
    expect(patched).toEqual([[typed, "tareEach", " 42.50 "]]);
  });
});

// ---- the table's layout (the owner's answers of 2026-10-11 to the two browser looks) ----

describe("the Containers grid: its layout", () => {
  it("is a table of fixed layout", () => {
    expect(classesOf(/<table\b[^>]*>/.exec(view([row()]))?.[0] ?? "")).toContain("table-fixed");
  });

  it("gives its six columns 22, 14, 19, 19, 16 and 10 percent of the table", () => {
    const html = view([row()]);
    // Each `<col>` tag of the render, read whole. One that is not a percent share reads as NaN.
    const shares = [...html.matchAll(/<col\b[^>]*>/g)].map((col) => Number(/^<col class="w-\[(\d+)%\]"\/>$/.exec(col[0])?.[1]));
    // The nth `<col>` sizes the nth column, so each share is paired with the heading over it.
    const [headings] = headingRowsOf(html);
    expect(shares.map((share, at) => [headings[at], share]))
      .toEqual([["Type", 22], ["Cust Cont Id", 14], ["Containers", 19], ["Tare each (lb)", 19], ["Tare total (lb)", 16], ["", 10]]);
  });

  it("each of a row's two boxes is as wide as its cell allows up to max-w-20, with no fixed width, and each box's cell carries pr-2", () => {
    expect(boxCells(view([row()]))).toEqual([
      [{ padding: ["pr-2"], box: ["w-full", "max-w-20"] }, { padding: ["pr-2"], box: ["w-full", "max-w-20"] }],
    ]);
  });

  it("a row's Type cell and its Cust Cont Id cell carry break-words, and no other cell of the row does", () => {
    expect(wrappingCells(view([row()]))).toEqual([["Type", "Cust Cont Id"]]);
  });
});

describe("a row that is added takes the order row's tare each", () => {
  const source = parsed(VIEW);
  /** A function declared inside `ContainersGridView`, run over `environment`. */
  function lifted(name: string, environment: Record<string, unknown>): () => void {
    const found = functionsNamed(functionsNamed(source, "ContainersGridView")[0], name);
    expect(found, name).toHaveLength(1);
    return run<() => void>(found[0].getText(source), environment);
  }
  const CANDIDATES: ContainerCandidate[] = [
    { id: "oc-1", typeName: "Steel Basket", customerContainerId: "BIN-0007", count: 3, tareEach: 42.5 },
    { id: "oc-2", typeName: "Bin", customerContainerId: "", count: 14, tareEach: 310 },
    { id: "oc-3", typeName: "Skid", customerContainerId: "", count: 2, tareEach: null },
  ];
  /** What the view's Add functions read by name, with the rows they hand up collected. */
  function grid(pick: string) {
    const added: unknown[] = [];
    return { added, names: { candidates: CANDIDATES, pick, prefillContainerRow, setPick: () => {}, onAddRows: (rows: unknown) => { added.push(rows); } } };
  }

  it("Add puts the picked order row on the grid with its number of containers and its tare each", () => {
    const { added, names } = grid("oc-2");
    lifted("addPicked", names)();
    expect(added).toEqual([[{ orderContainerId: "oc-2", count: "14", tareEach: "310" }]]);
  });

  it("Add all remaining puts every offered order row on the grid, one with no tare each as an empty box", () => {
    const { added, names } = grid("");
    lifted("addAllRemaining", names)();
    expect(added).toEqual([[
      { orderContainerId: "oc-1", count: "3", tareEach: "42.5" },
      { orderContainerId: "oc-2", count: "14", tareEach: "310" },
      { orderContainerId: "oc-3", count: "2", tareEach: "" },
    ]]);
  });

  it("the view declares no prefill of its own", () => {
    expect(functionsNamed(source, "prefillContainerRow").map((fn) => fn.name?.text)).toEqual([]);
  });

  // The two Add cases above hand the lifted functions the leaf's prefill themselves. This one reads
  // what the name is in the view's own file: the leaf's export, and nothing declared nearer.
  it("the view's prefillContainerRow is the leaf's: imported from it under its own name, and no variable or parameter of the file takes the name", () => {
    const NAME = "prefillContainerRow";
    const imported = all(source, ts.isImportSpecifier).filter((specifier) => specifier.name.text === NAME)
      .map((specifier) => `${(specifier.propertyName ?? specifier.name).text} from ${specifier.parent.parent.parent.moduleSpecifier.getText(source)}`);
    const declaredInTheFile = [...all(source, ts.isVariableDeclaration), ...all(source, ts.isParameter), ...all(source, ts.isBindingElement)]
      .filter((declaration) => declaration.name.getText(source) === NAME).map((declaration) => ts.SyntaxKind[declaration.kind]);
    expect({ imported, declaredInTheFile })
      .toEqual({ imported: ['prefillContainerRow from "@/lib/shipment-container-rows"'], declaredInTheFile: [] });
  });

  it("the new-shipment form hands the grid each order row with its tare each, a 0 as 0 and none as null", () => {
    const form = parsed(FORM);
    const [written] = all(form, ts.isPropertyAssignment).filter((property) => property.name.getText(form) === "containerCandidates");
    const o = { containers: [
      { id: "oc-1", count: 3, customerContainerId: "BIN-0007", type: { name: "Steel Basket" }, tareEach: 42.5 },
      { id: "oc-2", count: 14, customerContainerId: "", type: { name: "Bin" }, tareEach: 0 },
      { id: "oc-3", count: 2, customerContainerId: "", type: { name: "Skid" } },
    ] };
    expect(run(written.initializer.getText(form), { o })).toEqual([
      { id: "oc-1", typeName: "Steel Basket", customerContainerId: "BIN-0007", count: 3, tareEach: 42.5 },
      { id: "oc-2", typeName: "Bin", customerContainerId: "", count: 14, tareEach: 0 },
      { id: "oc-3", typeName: "Skid", customerContainerId: "", count: 2, tareEach: null },
    ]);
  });
});

// ---- kept container rows (the weights design §12.3: C7, C8, C12, A2) ----

describe("the Containers view: a kept container row", () => {
  const C7 = "Containers marked Kept are from earlier selections (the order-side rows were since corrected away). Only their Tare each can be changed.";
  /** A kept row as the saved page's grid holds it: its key is the shipment row's own id, and it
   *  names no order container. */
  const keptRow: ContainerRow = { key: "sc-2", isNew: false, orderContainerId: "", count: "3", tareEach: "42.5" };
  const skid: ContainerRow = { key: "sc-1", isNew: false, orderContainerId: "oc-1", count: "2", tareEach: "30" };
  const basket: KeptContainerInfo = { typeName: "Steel Basket", customerContainerId: "BIN-0007", count: 3 };
  /** The view over these rows. `kept` is what the grid is handed for the kept row, if anything. */
  function keptView(rows: ContainerRow[], kept?: KeptContainerInfo): string {
    return renderToStaticMarkup(<ContainersGridView rows={rows} candidates={[]}
      infoById={new Map([["oc-1", { typeName: "Skid", customerContainerId: "" }]])}
      keptByKey={kept ? new Map([["sc-2", kept]]) : undefined}
      gate={{ allowed: true, disabled: false, title: undefined }} onPatch={() => {}} onRemove={() => {}} onAddRows={() => {}} />);
  }
  /** What each paragraph above the table shows. */
  const above = (html: string): string[] => [...html.split("<table")[0].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);

  // The kept row has no box for its number of containers, and its Tare each box has its own name (A2).
  it.each([
    ["its type, Cust Cont Id and number of containers as text, its own box by name, its Tare total and Kept (C8, C12)",
      basket, ["Steel Basket", "BIN-0007", "3", "Kept container 1 tare each=42.5", "127.50", "Kept"]],
    ["a dash for no Cust Cont Id, as any other row shows",
      { ...basket, customerContainerId: "" }, ["Steel Basket", "—", "3", "Kept container 1 tare each=42.5", "127.50", "Kept"]],
    ["an empty type and two dashes when the grid was handed nothing for it",
      undefined, ["", "—", "—", "Kept container 1 tare each=42.5", "127.50", "Kept"]],
  ])("draws a kept row with %s, above a row that is not kept", (_what, kept, expected) => {
    expect(bodyRows(keptView([keptRow, skid], kept)))
      .toEqual([expected, ["Skid", "—", "Container 1 count=2", "Container 1 tare each=30", "60.00", "Remove"]]);
  });

  it("says once, above the table, what Kept means (C7), and says nothing where no row is kept", () => {
    expect([above(keptView([keptRow, skid], basket)), above(keptView([skid]))]).toEqual([[C7], []]);
  });

  // The kept row is the first of the two drawn. Its number of containers is text, in the cell that
  // holds a box on any other row.
  it("a kept row's number cell carries pr-2 with no box in it, and its Tare each box and that box's cell are as any other row's", () => {
    expect(boxCells(keptView([keptRow, skid], basket))[0])
      .toEqual([{ padding: ["pr-2"], box: null }, { padding: ["pr-2"], box: ["w-full", "max-w-20"] }]);
  });

  it("a kept row's Type cell and its Cust Cont Id cell carry break-words as any other row's, and no other cell of it does", () => {
    expect(wrappingCells(keptView([keptRow, skid], basket))[0]).toEqual(["Type", "Cust Cont Id"]);
  });

  // With no table in the render, `above` reads every paragraph of the view.
  it("draws a kept row that is the grid's only row, whole, under what Kept means, and says the grid is empty only when it has no row of either kind, with no table", () => {
    const keptOnly = keptView([keptRow], basket);
    const none = keptView([]);
    expect({
      keptOnly: { above: above(keptOnly), rows: bodyRows(keptOnly) },
      none: { above: above(none), table: none.includes("<table") },
    }).toEqual({
      keptOnly: { above: [C7], rows: [["Steel Basket", "BIN-0007", "3", "Kept container 1 tare each=42.5", "127.50", "Kept"]] },
      none: { above: ["No containers on this shipment yet."], table: false },
    });
  });
});
