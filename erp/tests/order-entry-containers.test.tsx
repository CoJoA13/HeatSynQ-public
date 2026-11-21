import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { entryTareEach, typeDefaultTare } from "@/lib/container-tare-prefill";
import { ADD_CONTAINER_ID, CONTAINER_KEY_BOXES, containerRefusalField } from "@/lib/container-refusal-field";
import { CHARGE_KEY_BOXES, chargeRefusalField } from "@/lib/charge-refusal-field";
import { LINE_KEY_BOXES, SERIAL_KEY_BOXES, lineRefusalField } from "@/lib/line-refusal-field";
import { splitLoads } from "@/lib/load-split";
import { decimalRefusal, readDecimal, readFinishedDecimal } from "@/lib/decimal-entry";
import { PLAN_WAIT_FIELD, PLAN_WAIT_MESSAGE } from "@/lib/entry-save-wait";
import { formatNumber } from "@/lib/format";
import { CHARGE_AMOUNT, LINE_NET_WEIGHT, SCALE_GROSS, TARE_EACH } from "@/lib/order-boxes";
import { INT4_MAX, LOAD_WEIGHT_MAX } from "@/lib/order-constants";
import { orderTotals, type OrderTotalsView } from "@/lib/order-totals";
import { EntryContainerRow } from "../src/app/orders/new/EntryContainerRow";
import { DraftSaveStatus } from "../src/app/orders/new/EntryWorkspace";
import { CONTAINER_TYPES_NOT_LOADED, entryContainerBody, entryTotalsInput } from "../src/app/orders/new/entry-state";
import { blankDraft, blankLine, type ContainerDraft, type ContainerTypeOption, type OrderDraftState,
  type PartOption } from "../src/app/orders/new/order-draft";
import { OrderLineCard, computeLineWeight, findDuplicateSerials } from "../src/app/orders/new/OrderLineCard";
import { declared as initializers, jsxTags, mentions } from "./helpers/jsx-source";
import { all, run } from "./helpers/source-lift";

// Order entry's container rows (the weights design §4.1 and §9.4).
//
// vitest has no DOM, so there are three kinds of proof here, each as far as it can reach.
// 1. EntryContainerRow is rendered to static markup: its fields and their order, its ids and
//    accessible names, what the Tare each box and the Tare total cell show, and when the optional
//    section opens.
// 2. A handler never runs in a static render. What a box writes is read from the row's own
//    onChange source and run.
// 3. page.tsx cannot be rendered. Its validate, serverProblem and buildCreateBody are lifted out of
//    its syntax tree and run over a hand-built environment, with nothing of the page's own module
//    in reach, the way lines-section-wiring.test.ts runs LinesSection's handlers. A page function
//    that gains a free identifier must gain it in the environment here in the same change, or the
//    case that reaches it stops with a ReferenceError. The initializer of its `totals` and its
//    effect that reads the container types are lifted and run the same way.
//    One case run through that `validate` is about a part line and no container row: the page's
//    refusal of a line's net weight (the weights design §11.3, G7).
//    Where the lifted `serverProblem` sends a server refusal of a part line, a serial or a charge is
//    held here too (#546): the page asks those leaves before anything else. The boxes those leaves
//    name are read from OrderLineCard rendered to static markup, and, for the quote list (drawn only
//    after a fetch) and the charges (on the page), from source.
// The leaves the row and the page call have their own suites: net-weight.test.ts,
// container-tare-prefill.test.ts, order-totals.test.ts and order-entry-state.test.ts. The syntax-tree
// walker `all` and the runner `run` are tests/helpers/source-lift.ts, and what a JSX attribute holds,
// a variable's initializer and how often a name is written are read through `jsxTags`, `declared`
// and `mentions` of tests/helpers/jsx-source.ts.

const TYPES: ContainerTypeOption[] = [
  { id: "steel", name: "Steel Basket", tareEach: 42.5 },
  { id: "wire", name: "Wire Basket", tareEach: null },
  { id: "bin", name: "Bin", tareEach: 310 },
];
/** Three steel baskets holding 252 pieces in all, with nothing typed in the Tare each box. */
function row(over: Partial<ContainerDraft> = {}): ContainerDraft {
  return { id: "c1", typeId: "steel", count: "3", pieces: "252", tareEachOverride: null, scaleGross: "",
    customerContainerId: "", ...over };
}

// ---- the row's markup ----

function render(over: Partial<ContainerDraft> = {}, props: { index?: number; errorFieldIds?: string[] } = {}): string {
  return renderToStaticMarkup(<EntryContainerRow container={row(over)} index={props.index ?? 0}
    containerTypes={TYPES} errorFieldIds={props.errorFieldIds ?? []} onChange={() => {}} onRemove={() => {}} />);
}
/** The words that head each cell, in the order the row draws them. */
const captions = (html: string): string[] =>
  [...html.matchAll(/<(?:label|div)\b[^>]*>([^<]+)</g)].map(match => match[1]);
/** The opening tag of the one box with this accessible name. */
function box(html: string, name: string): string {
  const found = (html.match(/<(?:input|select)\b[^>]*>/g) ?? []).filter(tag => tag.includes(`aria-label="${name}"`));
  expect(found, name).toHaveLength(1);
  return found[0];
}
const tareTotalCell = (html: string) => html.match(/Tare total \(lb\)<p\b[^>]*>([^<]*)<\/p>/)?.[1];
const sectionOpen = (html: string) => html.match(/<details\b[^>]*>/)?.[0].includes('open=""');

describe("EntryContainerRow: the fields", () => {
  it("heads its cells in the design's order, with Tare each and Tare total in the main row", () => {
    const [main, optional] = render().split("<details");
    expect(captions(main)).toEqual(["Type", "Containers", "Pieces (total)", "Tare each (lb)", "Tare total (lb)"]);
    expect(captions(optional)).toEqual(["Scale gross (lb)", "Cust Cont Id"]);
    expect(optional).toContain("Container weights &amp; IDs");
  });

  it("gives each box its id and its accessible name, by the row's number", () => {
    const html = render({}, { index: 1 });
    for (const [name, suffix] of [["type", "type"], ["count", "count"], ["pieces", "pieces"],
      ["tare each", "tareEach"], ["scale gross", "scaleGross"], ["customer container id", "customerContainerId"]]) {
      expect(box(html, `Container 2 ${name}`)).toContain(`id="entry-container-c1-${suffix}"`);
    }
    for (const gone of ["Container 2 quantity", "Container 2 tare weight", "Container 2 gross weight"]) {
      expect(html).not.toContain(gone);
    }
  });

  it("shows each box the draft row's own figure for it, and the picked type in the Type list", () => {
    // Every figure differs from the others, so a box that reads another field shows the wrong one.
    const html = render({ typeId: "bin", count: "14", pieces: "252", tareEachOverride: "50", scaleGross: "580",
      customerContainerId: "BIN-9" });
    const shown = (name: string) => box(html, `Container 1 ${name}`).match(/\svalue="([^"]*)"/)?.[1];
    expect(["count", "pieces", "tare each", "scale gross", "customer container id"].map(shown))
      .toEqual(["14", "252", "50", "580", "BIN-9"]);
    // A list has no value of its own in static markup: the picked type is the one option marked
    // selected. The list offers the blank line and then the page's types, in the page's order.
    const options = (markup: string) => [...markup.matchAll(/<option value="([^"]*)"( selected="")?>([^<]*)<\/option>/g)]
      .map((option) => [option[1], option[3], option[2] !== undefined]);
    expect(options(html)).toEqual([
      ["", "— choose —", false], ["steel", "Steel Basket", false], ["wire", "Wire Basket", false], ["bin", "Bin", true],
    ]);
    // A row with no type shows the blank line.
    expect(options(render({ typeId: null })).filter((option) => option[2])).toEqual([["", "— choose —", true]]);
  });

  it("shows the type's default until the Tare each box is typed in, and the operator's text from then on", () => {
    const shown = (over: Partial<ContainerDraft>) => box(render(over), "Container 1 tare each");
    expect(shown({})).toContain('value="42.5"');
    expect(shown({ typeId: "bin" })).toContain('value="310"');                         // it follows a change of type
    expect(shown({ typeId: "wire" })).toContain('value=""');                           // a type with no default
    expect(shown({ tareEachOverride: "50" })).toContain('value="50"');
    expect(shown({ tareEachOverride: "50", typeId: "bin" })).toContain('value="50"');  // a change of type leaves typed text alone
    expect(shown({ tareEachOverride: "" })).toContain('value=""');                     // a cleared box stays cleared
  });

  it("works out Tare total from the row as it is typed, and shows the dash when it cannot", () => {
    expect(tareTotalCell(render())).toBe("127.50");                                    // 3 at 42.50
    expect(tareTotalCell(render({ typeId: "bin", count: "14" }))).toBe("4,340.00");    // the owner's 14 bins at 310 lb
    expect(tareTotalCell(render({ tareEachOverride: "50" }))).toBe("150.00");
    expect(tareTotalCell(render({ tareEachOverride: "0" }))).toBe("0.00");             // a typed 0 is a tare each
    for (const over of [{ count: "" }, { typeId: "wire" }, { tareEachOverride: "" }, { tareEachOverride: "4." }]) {
      expect(tareTotalCell(render(over)), JSON.stringify(over)).toBe("—");
    }
  });

  it("has no Total pieces and no row Net", () => {
    const html = render({ scaleGross: "580", tareEachOverride: "42.5" });
    for (const gone of ["Total pieces", "Net:", "Qty/container"]) expect(html).not.toContain(gone);
  });

  it("opens the optional section only for a scale gross, a customer container id or a refusal on this row", () => {
    expect(sectionOpen(render())).toBe(false);                               // a type's default does not open it
    expect(sectionOpen(render({ tareEachOverride: "50" }))).toBe(false);     // nor a typed tare each: its box is in the main row
    expect(sectionOpen(render({ scaleGross: "580" }))).toBe(true);
    expect(sectionOpen(render({ customerContainerId: "BIN-9" }))).toBe(true);
    expect(sectionOpen(render({}, { errorFieldIds: ["entry-container-c1-pieces"] }))).toBe(true);
    expect(sectionOpen(render({}, { errorFieldIds: ["entry-container-c2-pieces"] }))).toBe(false);
  });

  it("opens for a refusal on this row wherever it stands in the page's list, not only the first", () => {
    // Review Focus 5: Save lists every refusal, and each container whose Scale gross is refused
    // opens its section. A row's refusal behind another row's still opens this row.
    const refused = ["entry-line-line-1-weight", "entry-container-c0-scaleGross", "entry-container-c1-scaleGross"];
    expect(sectionOpen(render({}, { errorFieldIds: refused }))).toBe(true);
    expect(sectionOpen(render({}, { errorFieldIds: refused.slice(0, 2) }))).toBe(false);
  });
});

// ---- reading the two sources ----

/** Both files as `jsxTags` takes them: a path under `erp/`. */
const ROW_FILE = "src/app/orders/new/EntryContainerRow.tsx";
const PAGE_FILE = "src/app/orders/new/page.tsx";
const pageFile = fileURLToPath(new URL(`../${PAGE_FILE}`, import.meta.url));
const pageSource = ts.createSourceFile(pageFile, readFileSync(pageFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// ---- what a box writes, from the row's own handlers ----

/** What the box whose accessible name ends in `nameEnd` hands the page when `value` is typed or picked. */
function written(nameEnd: string, value: string): Partial<ContainerDraft>[] {
  const boxes = jsxTags(ROW_FILE).filter((tag) => tag.attr("aria-label")?.endsWith(` ${nameEnd}\``));
  expect(boxes, nameEnd).toHaveLength(1);
  const patches: Partial<ContainerDraft>[] = [];
  const handler = run<(event: { target: { value: string } }) => void>(
    boxes[0].attr("onChange") ?? "undefined",
    { onChange: (patch: Partial<ContainerDraft>) => { patches.push(patch); } });
  handler({ target: { value } });
  return patches;
}

describe("EntryContainerRow: what a box writes", () => {
  it("writes the type alone when the type is changed, so an untyped Tare each box follows the new type", () => {
    expect(written("type", "bin")).toStrictEqual([{ typeId: "bin" }]);
    expect(written("type", "")).toStrictEqual([{ typeId: null }]);
  });

  it("writes the operator's own text for Tare each, a cleared box included", () => {
    expect(written("tare each", "50")).toStrictEqual([{ tareEachOverride: "50" }]);
    expect(written("tare each", "")).toStrictEqual([{ tareEachOverride: "" }]);
  });

  it("writes Containers, Pieces, Scale gross and the customer container id under their own keys", () => {
    expect(written("count", "3")).toStrictEqual([{ count: "3" }]);
    expect(written("pieces", "252")).toStrictEqual([{ pieces: "252" }]);
    expect(written("scale gross", "580")).toStrictEqual([{ scaleGross: "580" }]);
    expect(written("customer container id", "BIN-9")).toStrictEqual([{ customerContainerId: "BIN-9" }]);
  });
});

// ---- the page's own functions, run ----

function declared(name: string): ts.FunctionDeclaration {
  const found = all(pageSource, ts.isFunctionDeclaration).filter((f) => f.name?.text === name);
  if (found.length !== 1) throw new Error(`Expected one function ${name} in orders/new/page.tsx, found ${found.length}`);
  return found[0];
}
/** The page's function `name` as it is written, run over `environment` and nothing else of the page. */
function actual<T>(name: string, environment: Record<string, unknown>): T {
  return run<T>(declared(name).getText(pageSource), environment);
}

const PART: PartOption = {
  id: "part-1", customerId: "cust-1", partNumber: "P-1", name: "Shaft", eachWeight: 2.5,
  serializationRequired: false, hasProcessSteps: true, certRequired: null, certScope: null,
  inheritedCertRequired: false, inheritedCertScope: "ORDER",
};
/** A draft the page would save: one customer, one part line of 30 pieces, and these container rows. */
function entryDraft(containers: ContainerDraft[]): OrderDraftState {
  return { ...blankDraft(), customerId: "cust-1",
    lines: [{ ...blankLine(), id: "line-1", partId: "part-1", qty: "30" }], containers };
}
type Problem = { message: string; tab: string; fieldId: string };

/** The page's `validate`, over a draft whose customer, line and load plan are all in order. A case
 *  about a part line hands its own `draft`, and `containers` is then not read. It answers every
 *  refusal, in the order the page lists them. */
function validate(containers: ContainerDraft[], containerTypes: readonly ContainerTypeOption[] = TYPES,
  draft: OrderDraftState = entryDraft(containers)): Problem[] {
  return actual<() => Problem[]>("validate", {
    draft, displayedPo: "", serialProblems: {}, customerParts: [PART],
    decimalRefusal, LINE_NET_WEIGHT, TARE_EACH, SCALE_GROSS, CHARGE_AMOUNT, PLAN_WAIT_FIELD, PLAN_WAIT_MESSAGE,
    computeLineWeight, findDuplicateSerials, leadValid: true, INT4_MAX, formatNumber,
    containerTypes, entryTareEach, typeDefaultTare,
    adjustmentResult: { errors: [] }, preview: {}, currentState: null,
  })();
}

describe("order entry page: container validation", () => {
  const LIMIT = "2,147,483,647";

  // Each row's tail is what follows "Container 1" in its refusal: ": " and the sentence for a
  // refusal that is not about a decimal box, ", " and the box's label for one that is.
  it.each<[string, Partial<ContainerDraft>, string, string]>([
    ["a blank Containers box (V5)", { count: "" }, `: enter a whole number of containers from 1 to ${LIMIT}.`, "count"],
    ["a Containers figure past the column (V5)", { count: "2147483648" }, `: enter a whole number of containers from 1 to ${LIMIT}.`, "count"],
    ["Pieces that are not a whole number (V6)", { pieces: "2.5" }, `: Pieces must be a whole number from 1 to ${LIMIT}.`, "pieces"],
    ["Pieces past the column (V6)", { pieces: "2147483648" }, `: Pieces must be a whole number from 1 to ${LIMIT}.`, "pieces"],
    ["a negative typed Tare each (V7)", { tareEachOverride: "-1" }, ", Tare each (lb): cannot be negative.", "tareEach"],
    ["a typed Tare each with three decimals (V7)", { tareEachOverride: "42.505" }, ", Tare each (lb): use at most 2 digits after the point.", "tareEach"],
    ["a Scale gross that is not a number (V8)", { scaleGross: "abc" }, ", Scale gross (lb): enter a number without $ or commas, such as 0.36.", "scaleGross"],
    ["a row with no type", { typeId: null }, ": pick a type.", "type"],
    ["a customer container id past 60 characters", { customerContainerId: "x".repeat(61) }, ": customer container ID must be at most 60 characters.", "customerContainerId"],
  ])("refuses %s on its own box", (_what, over, tail, suffix) => {
    expect(validate([row(over)])).toEqual([{ message: `Container 1${tail}`, tab: "parts",
      fieldId: `entry-container-c1-${suffix}` }]);
  });

  it("names the row by its number", () => {
    expect(validate([row(), row({ id: "c2", pieces: "0" })])).toEqual([{
      message: `Container 2: Pieces must be a whole number from 1 to ${LIMIT}.`, tab: "parts",
      fieldId: "entry-container-c2-pieces" }]);
  });

  it("checks Tare each as the box shows it, a type's default included, and names it as a typed one", () => {
    // No stored default can have three decimals. This list is made by hand so the case can tell
    // what the box shows from what was typed.
    const types: ContainerTypeOption[] = [...TYPES, { id: "odd", name: "Odd", tareEach: 1.005 }];
    expect(validate([row({ typeId: "odd" })], types)).toEqual([{
      message: "Container 1, Tare each (lb): use at most 2 digits after the point.", tab: "parts",
      fieldId: "entry-container-c1-tareEach" }]);
  });

  it("passes a row that follows its type's default, and a figure typed over it", () => {
    expect(validate([row()])).toEqual([]);
    expect(validate([row({ tareEachOverride: " 42.50 " })])).toEqual([]);
    expect(validate([row({ tareEachOverride: "0" })])).toEqual([]);
  });

  it("never refuses a blank or mismatched container quantity, or a blank weight", () => {
    // 252 pieces in containers against 30 on the part line. The totals table shows both, and Save goes on.
    expect(validate([row()])).toEqual([]);
    expect(validate([row({ pieces: "", tareEachOverride: "", scaleGross: "" }),
      row({ id: "c2", typeId: "wire", pieces: "" })])).toEqual([]);
  });

  it("skips a typeless row's count, pieces and tare each, and still checks its scale gross and id", () => {
    expect(validate([row({ typeId: null, count: "", pieces: "2.5", tareEachOverride: "-1", scaleGross: "abc",
      customerContainerId: "x".repeat(61) })])).toEqual([
      { message: "Container 1: pick a type.", tab: "parts", fieldId: "entry-container-c1-type" },
      { message: "Container 1, Scale gross (lb): enter a number without $ or commas, such as 0.36.", tab: "parts",
        fieldId: "entry-container-c1-scaleGross" },
      { message: "Container 1: customer container ID must be at most 60 characters.", tab: "parts",
        fieldId: "entry-container-c1-customerContainerId" },
    ]);
  });
});

describe("order entry page: Save lists every refusal", () => {
  it("lists a line's weight, a tare each, a second container's scale gross and a charge's amount, in the page's order", () => {
    // Owner answer 2: every refusal from all three tabs, one per line. The page's order is
    // validate's: the part lines, the containers, then the charges (a charge is on Order details).
    const base = entryDraft([]);
    const draft: OrderDraftState = { ...base,
      lines: [{ ...base.lines[0], weightOverride: "1e2" }],
      containers: [row({ tareEachOverride: "-1" }), row({ id: "c2", scaleGross: "580.123" })],
      charges: [{ id: "ch1", description: "Rush", amount: "-5" }] };
    expect(validate([], TYPES, draft)).toEqual([
      { message: "Lead line, Net weight (lb): enter a number without $ or commas, such as 0.36.", tab: "parts",
        fieldId: "entry-line-line-1-weight" },
      { message: "Container 1, Tare each (lb): cannot be negative.", tab: "parts", fieldId: "entry-container-c1-tareEach" },
      { message: "Container 2, Scale gross (lb): use at most 2 digits after the point.", tab: "parts",
        fieldId: "entry-container-c2-scaleGross" },
      { message: "Charge 1, Amount: cannot be negative.", tab: "details", fieldId: "entry-charge-ch1-amount" },
    ]);
  });

  it("lists the load adjustment's refusals with the rest, and asks for a load plan only when nothing else is refused", () => {
    const adjustment = (errors: { fieldId: string; message: string }[], preview: unknown, draft = entryDraft([row()])) =>
      actual<() => Problem[]>("validate", {
        draft, displayedPo: "", serialProblems: {}, customerParts: [PART],
        decimalRefusal, LINE_NET_WEIGHT, TARE_EACH, SCALE_GROSS, CHARGE_AMOUNT, PLAN_WAIT_FIELD, PLAN_WAIT_MESSAGE,
        computeLineWeight, findDuplicateSerials, leadValid: true, INT4_MAX, formatNumber,
        containerTypes: TYPES, entryTareEach, typeDefaultTare,
        adjustmentResult: { errors }, preview, currentState: null,
      })();
    const errors = [
      { fieldId: "entry-load-quantity", message: "Pieces per load must be a whole number greater than zero, or blank for no cap." },
      { fieldId: "entry-load-weight", message: "Weight per load (lb): must be greater than zero." },
    ];
    expect(adjustment(errors, null)).toEqual(errors.map(error => ({ ...error, tab: "process" })));
    expect(adjustment([], null)).toEqual([
      { message: "Wait for a current load plan before saving.", tab: "process", fieldId: "entry-refresh-plan" }]);
    const noCustomer = { ...entryDraft([row()]), customerId: null };
    expect(adjustment([], null, noCustomer)).toEqual([
      { message: "Pick a customer.", tab: "details", fieldId: "entry-customer" }]);
  });
});

describe("order entry page: Save while the load plan is pending (R12, #662)", () => {
  const text = readFileSync(fileURLToPath(new URL("../src/app/orders/new/page.tsx", import.meta.url)), "utf8");

  it("asks the wait leaf what Save does, and sends the preview at once only when none is out for this identity", () => {
    expect(text).toContain("const decision = saveDecision({ problems, availability: planAvailability, identity: previewIdentity, pending: pendingSave });");
    expect(text).toContain('if (decision.kind === "already-waiting") return;');
    expect(text).toContain("if (sentFor.current !== previewIdentity) setRushPlan(previewIdentity);");
    expect(text).toContain("const outcome = pendingSaveOutcome(pendingSave, previewIdentity, currentState);");
  });

  it("labels Save \"Checking plan…\" and holds it while a save waits on this identity, and never sets saving", () => {
    expect(text).toContain('const waitingOnPlan = pendingSave?.identity === previewIdentity;');
    expect(text).toContain("disabled={saving || saveGate.disabled || waitingOnPlan}");
    expect(text).toContain('{waitingOnPlan ? "Checking plan…" : saving ? "Saving…" : "Save only"}');
  });

  it("draws the print-reason span only while the plan is not loading, and describes Save & Print by it only then", () => {
    expect(text).toContain('const printReasonShown = !!printProblem && planAvailability !== "loading";');
    expect(text).toContain('aria-describedby={printReasonShown ? "entry-print-reason" : undefined}');
    expect(text).toContain('{printReasonShown && <span id="entry-print-reason"');
  });
});

describe("order entry page: a part line's net weight", () => {
  // The weights design §11.3, G7. The problem still points at the line's own weight box.
  const withLines = (...lines: Partial<OrderDraftState["lines"][number]>[]): OrderDraftState => {
    const base = entryDraft([]);
    return { ...base, lines: lines.map((over, i) => ({ ...base.lines[0], id: `line-${i + 1}`, ...over })) };
  };

  it("refuses a net weight of zero on the line's weight box, for the lead and for a rider", () => {
    expect(validate([], TYPES, withLines({ weightOverride: "0" }))).toEqual([{
      message: "Lead line, Net weight (lb): must be greater than zero.",
      tab: "parts", fieldId: "entry-line-line-1-weight" }]);
    expect(validate([], TYPES, withLines({}, { weightOverride: "0" }))).toEqual([{
      message: "Line 2, Net weight (lb): must be greater than zero.",
      tab: "parts", fieldId: "entry-line-line-2-weight" }]);
  });

  it("refuses a cleared weight box: a line's net weight must hold a figure", () => {
    expect(validate([], TYPES, withLines({ weightOverride: "  " }))).toEqual([{
      message: "Lead line, Net weight (lb): must be greater than zero.",
      tab: "parts", fieldId: "entry-line-line-1-weight" }]);
  });

  it("names a weight with too many decimals by its line and label", () => {
    expect(validate([], TYPES, withLines({}, { weightOverride: "42.505" }))).toEqual([{
      message: "Line 2, Net weight (lb): use at most 2 digits after the point.",
      tab: "parts", fieldId: "entry-line-line-2-weight" }]);
  });

  it("asks a line with no part for a part alone, and never for a weight", () => {
    // Review Focus 1: with no part there is no weight to work out.
    expect(validate([], TYPES, withLines({ partId: null, qty: "abc", weightOverride: "0" }))).toEqual([{
      message: "Lead line: pick a part.", tab: "parts", fieldId: "entry-line-line-1-part" }]);
  });

  it.each([" 42.50 ", ".36", "36."])("accepts the weight %j at Save", (weightOverride) => {
    expect(validate([], TYPES, withLines({ weightOverride }))).toEqual([]);
  });

  it("skips the worked-out weight of a line whose quantity is refused, and checks a typed one", () => {
    // Nothing to work a weight out from: the quantity's refusal alone.
    expect(validate([], TYPES, withLines({ qty: "abc" }))).toEqual([{
      message: "Lead line: enter a whole quantity from 1 to 10,000,000.", tab: "parts", fieldId: "entry-line-line-1-qty" }]);
    // A typed weight is the operator's own figure, checked whatever the quantity holds.
    expect(validate([], TYPES, withLines({ qty: "abc", weightOverride: "0" }))).toEqual([
      { message: "Lead line: enter a whole quantity from 1 to 10,000,000.", tab: "parts", fieldId: "entry-line-line-1-qty" },
      { message: "Lead line, Net weight (lb): must be greater than zero.", tab: "parts", fieldId: "entry-line-line-1-weight" },
    ]);
    expect(validate([], TYPES, withLines({ qty: "abc", weightOverride: "42.5" }))).toEqual([{
      message: "Lead line: enter a whole quantity from 1 to 10,000,000.", tab: "parts", fieldId: "entry-line-line-1-qty" }]);
  });

  it("lists one line for a line's serials, its first refused serial, and keeps the duplicate and count lines", () => {
    const serials = [
      { id: "s1", serial: "A-1", description: "" },
      { id: "s2", serial: "  ", description: "" },
      { id: "s3", serial: "x".repeat(121), description: "" },
      { id: "s4", serial: "A-4", description: "d".repeat(501) },
      { id: "s5", serial: "A-1", description: "" },
    ];
    expect(validate([], TYPES, withLines({ serials }))).toEqual([
      { message: 'Lead line: serial "A-1" is entered twice.', tab: "parts", fieldId: "entry-line-line-1-serial-s1" },
      { message: "Lead line: serial 2 must be 1–120 characters.", tab: "parts", fieldId: "entry-line-line-1-serial-s2" },
    ]);
    // A description refused first is the line's one serial line too.
    expect(validate([], TYPES, withLines({ serials: [serials[3], serials[1], serials[2]] }))).toEqual([{
      message: "Lead line: serial 1 description must be at most 500 characters.", tab: "parts",
      fieldId: "entry-line-line-1-serial-s4-description" }]);
  });

  it("finds a serial repeated once trimmed, quotes the trimmed value, and points at its first box (#546)", () => {
    // The serial with the space comes first: its box is the one the refusal names.
    const serials = [{ id: "s1", serial: "A-1 ", description: "" }, { id: "s2", serial: "A-1", description: "" }];
    expect(validate([], TYPES, withLines({ serials }))).toEqual([{
      message: 'Lead line: serial "A-1" is entered twice.', tab: "parts", fieldId: "entry-line-line-1-serial-s1" }]);
  });

  it("refuses blank serials as blank only, never as a duplicate (#546, owner answer 3)", () => {
    for (const blanks of [["", "  "], ["", ""]]) {
      const serials = blanks.map((serial, i) => ({ id: `s${i + 1}`, serial, description: "" }));
      expect(validate([], TYPES, withLines({ serials }))).toEqual([{
        message: "Lead line: serial 1 must be 1–120 characters.", tab: "parts", fieldId: "entry-line-line-1-serial-s1" }]);
    }
  });

  /** The page's part lines as `name` reads them, over `draft`: its own initializers, run. */
  function lines(name: "normalizedLines" | "totalsLines", draft: OrderDraftState): unknown[] {
    const [readLines] = initializers(PAGE_FILE, "readLines");
    const written = initializers(PAGE_FILE, name);
    expect(written).toHaveLength(1);
    return run<unknown[]>(written[0], {
      readLines: run(readLines, { draft, customerParts: [PART], computeLineWeight }),
      readDecimal, readFinishedDecimal, LINE_NET_WEIGHT });
  }

  it("reads a weight being typed as no figure yet in the totals table, and a finished one as its figure", () => {
    // Spec §11 and the weights design's point 4: the totals table reads a box as it is being typed.
    expect(lines("totalsLines", withLines({ weightOverride: "42." }))).toEqual([null]);
    expect(lines("totalsLines", withLines({ weightOverride: "42.5" }))).toEqual([{ partId: "part-1", qty: 30, weight: 42.5 }]);
    expect(lines("totalsLines", withLines({ weightOverride: null }))).toEqual([{ partId: "part-1", qty: 30, weight: 75 }]);
  });

  it("previews the figure Save takes: a weight of 36. is sent as 36, and Save is not held for a plan", () => {
    const draft = withLines({ weightOverride: "36." });
    const normalizedLines = lines("normalizedLines", draft);
    expect(normalizedLines).toEqual([{ partId: "part-1", qty: 30, weight: 36 }]);
    const validLines = run<boolean>(initializers(PAGE_FILE, "validLines")[0], { normalizedLines });
    const [planInput] = initializers(PAGE_FILE, "planInput");
    expect(run(planInput, { draftReady: true, saveGate: { allowed: true }, customerId: "cust-1", validLines,
      adjustmentResult: { adjustment: { source: "part" } }, adjustmentMatchesLead: true, normalizedLines }))
      .toEqual({ customerId: "cust-1", lines: [{ partId: "part-1", qty: 30, weight: 36 }], loadAdjustment: { source: "part" } });
    // With the preview that input brings, Save refuses nothing.
    expect(validate([], TYPES, draft)).toEqual([]);
  });
});

/** The page's `serverProblem` over `draft`, in a document whose one element is the one whose id is
 *  `inDocument`. `asked` is every id the page looked for, in order. */
function landing(message: string, draft: OrderDraftState, inDocument?: string): { problem: Problem; asked: string[] } {
  const asked: string[] = [];
  const document = {
    getElementById: (id: string): object | null => { asked.push(id); return id === inDocument ? {} : null; },
  };
  const problem = actual<(message: string) => Problem>("serverProblem",
    { draft, containerRefusalField, lineRefusalField, chargeRefusalField, document })(message);
  return { problem, asked };
}

describe("order entry page: where a server refusal lands", () => {
  function refusal(message: string, containers: ContainerDraft[] = [row(), row({ id: "c2" })]): Problem {
    return landing(message, entryDraft(containers)).problem;
  }

  // Refusals in the server's shape, each about the first row. The server's own words for a decimal
  // are decimalField's (src/server/decimal-field.ts). Where each kind of refusal goes is
  // tests/container-refusal-field.test.ts's, against the server's own refusals; these hold that the
  // page asks the leaf, with its rows in order, and shows what it answers.
  it.each([
    ["containers.0.tareEach: cannot be negative.", "tareEach"],
    ["containers.0.scaleGross: use at most 2 digits after the point.", "scaleGross"],
    ["containers.0.count: Too small: expected number to be >=1", "count"],
    // The key decides these two, as it does every keyed case here. The word scan decides only a
    // refusal that names the row and no key: the `qty` case below, and the one after it.
    ["containers.0.pieces: Too small: expected number to be >=1", "pieces"],
    ["containers.0.pieces: Too big: expected number to be <=2147483647", "pieces"],
    ['containers.0: Unrecognized key: "qty"', "pieces"],
    ["containers.0.typeId: Too small: expected string to have >=1 characters", "type"],
  ])("sends %s to its box", (message, suffix) => {
    expect(refusal(message)).toEqual({ message, tab: "parts", fieldId: `entry-container-c1-${suffix}` });
  });

  it("sends a container refusal that says quantity, with none of the other words, to the Pieces box", () => {
    // No server sentence of today is worded so: the order service names the key, `pieces`. The
    // router still reads the word, and this holds where it leads. Without it the box is Type.
    const message = "containers.0: quantity must be a whole number";
    expect(refusal(message)).toEqual({ message, tab: "parts", fieldId: "entry-container-c1-pieces" });
  });

  it.each([
    ["containers.1.tareEach: cannot be negative.", "entry-container-c2-tareEach"],
    ["containers.1.customerContainerId: Too big: expected string to have <=60 characters", "entry-container-c2-customerContainerId"],
    ["containers.2.count: Too small: expected number to be >=1", "entry-container-c3-count"],
  ])("sends %s to the row the server names, counting from 0 (#494)", (message, fieldId) => {
    const containers = [row(), row({ id: "c2" }), row({ id: "c3" })];
    expect(refusal(message, containers)).toEqual({ message, tab: "parts", fieldId });
  });

  it.each([
    ["That container type does not exist", [row(), row({ id: "c2" })]],
    ["That container type does not exist", []],
    ["containers.2.count: Too small: expected number to be >=1", [row(), row({ id: "c2" })]],
  ])("sends %s, which names no row the page holds, to Add container", (message, containers) => {
    expect(refusal(message, containers)).toEqual({ message, tab: "parts", fieldId: ADD_CONTAINER_ID });
  });

  it("sends a part line's refusal whose part number says container to that line, not to a container row", () => {
    const message = "Line 1 (ACME · CONTAINER-9): that part is inactive";
    expect(refusal(message)).toEqual({ message, tab: "parts", fieldId: "entry-line-line-1-part" });
  });
});

describe("order entry page: where a server refusal of a part line, a serial or a charge lands (#546)", () => {
  // The page asks the part line leaf, then the charge leaf, before the date check (owner answer 1,
  // 2026-10-18). Where each kind of refusal goes is tests/line-refusal-field.test.ts's and
  // tests/charge-refusal-field.test.ts's, against the server's own refusals; these hold that the page
  // asks the leaves first, with its lines and charges in order, and shows what they answer, on the
  // tab each answers. The refusals are typed in the server's words (`readableMessage` over the create
  // schema, `lineLabel` with `judgeQuoteLine` and `duplicateSerialError`, `lockCurrentRevision`,
  // `parseDate`, and `createOrder`'s customer and setup refusals), but for the two load sentences,
  // which `splitLoads` throws here and `runSplitLoads` passes on word for word. Two part lines and
  // two charges, so a line or charge read from the wrong end of its list, or a refusal that names no
  // line read on line 2, lands somewhere else.
  /** The page's draft: two part lines, the second holding the serials `B` and `A ` (with a space),
   *  two container rows and `charges`. */
  function draftOf(charges: OrderDraftState["charges"] = [
    { id: "ch1", description: "Rush", amount: "25" },
    { id: "ch2", description: "Cert", amount: "10" },
  ]): OrderDraftState {
    const base = entryDraft([row(), row({ id: "c2" })]);
    return { ...base, charges, lines: [base.lines[0], { ...blankLine(), id: "line-2", partId: "part-1", qty: "30",
      serials: [{ id: "s1", serial: "B", description: "" }, { id: "s2", serial: "A ", description: "" }] }] };
  }
  const problemOf = (message: string, draft = draftOf()) => landing(message, draft).problem;
  /** What `run` throws, as `runSplitLoads` passes it on. */
  function thrown(run: () => unknown): string {
    try { run(); } catch (error) { return (error as Error).message; }
    throw new Error("expected a throw");
  }

  it("sends a refused quantity on the second line to that line's Qty box, counting from 0", () => {
    const message = "lines.1.qty: Too small: expected number to be >=1";
    expect(problemOf(message)).toEqual({ message, tab: "parts", fieldId: "entry-line-line-2-qty" });
  });

  it("sends a refused amount on the second charge to that charge's Amount box, on Order details", () => {
    const message = "charges.1.amount: cannot be negative.";
    expect(problemOf(message)).toEqual({ message, tab: "details", fieldId: "entry-charge-ch2-amount" });
  });

  it("sends a charge refusal on a page holding no charge to the lead line's Part box, on Parts (owner answer 4)", () => {
    const message = "charges.0.amount: cannot be negative.";
    expect(problemOf(message, draftOf([]))).toEqual({ message, tab: "parts", fieldId: "entry-line-line-1-part" });
  });

  it.each([
    // Owner answer 1: the leaves are asked before the date check, which reads the whole message.
    "Line 2 (ACME · RECEIVED DATE-1): that part is inactive",
    // The old word scan read the part number and took this to the Qty box.
    "Line 2 (ACME · QTY-9): that part is inactive",
    "Line 2: that part does not exist",
  ])("sends %s to line 2's Part box", (message) => {
    expect(problemOf(message)).toEqual({ message, tab: "parts", fieldId: "entry-line-line-2-part" });
  });

  it.each([
    "Line 2 (ACME · P-2): Quote #12 is closed",
    "lines.1.quoteLineId: Too small: expected string to have >=1 characters",
  ])("sends %s to line 2's quote list while the document holds it, and to its Part box when it does not (D4)", (message) => {
    const shown = landing(message, draftOf(), "entry-line-line-2-quote");
    expect(shown).toEqual({ problem: { message, tab: "parts", fieldId: "entry-line-line-2-quote" },
      asked: ["entry-line-line-2-quote"] });
    const missing = landing(message, draftOf());
    expect(missing).toEqual({ problem: { message, tab: "parts", fieldId: "entry-line-line-2-part" },
      asked: ["entry-line-line-2-quote"] });
  });

  it("sends a serial entered twice to line 2's serial whose trimmed value it names", () => {
    const message = 'Line 2 (ACME · P-2): serial "A" is entered twice';
    expect(problemOf(message)).toEqual({ message, tab: "parts", fieldId: "entry-line-line-2-serial-s2" });
  });

  const quantitySplit = thrown(() => splitLoads({ totalQty: INT4_MAX + 1, totalWeightCents: BigInt(0), loadQty: null, loadWeight: null }));
  const weightSplit = thrown(() => splitLoads({ totalQty: 1,
    totalWeightCents: BigInt(Math.round(LOAD_WEIGHT_MAX * 100)) + BigInt(1), loadQty: null, loadWeight: null }));

  it.each<[string, string, string]>([
    ["This part has no process steps", "parts", "entry-line-line-1-part"],
    ["That serial is already on this line", "parts", "entry-line-line-1-serials"],
    [quantitySplit, "parts", "entry-line-line-1-qty"],
    [weightSplit, "parts", "entry-line-line-1-weight"],
    ["That customer does not exist", "details", "entry-customer"],
    ["Finish setup before entering orders — Company identity (name, address, phone) is not set. "
      + "Complete setup on the Setup page (/setup).", "process", "entry-refresh-plan"],
    ['"2026-13-01" is not a valid date (yyyy-mm-dd) for Received date', "details", "entry-received"],
    ['"2026-13-01" is not a valid date (yyyy-mm-dd) for Request date', "details", "entry-request"],
    ['"2026-13-01" is not a valid date (yyyy-mm-dd) for Target date', "details", "entry-target"],
  ])("keeps today's routing for %s, which names no line", (message, tab, fieldId) => {
    expect(problemOf(message)).toEqual({ message, tab, fieldId });
  });

  it("reads the load sentences as the server words them", () => {
    // What the two cases above are about: a load's quantity and weight, each naming no line.
    expect(quantitySplit).toMatch(/^Load 1's quantity .* — check the line quantities$/);
    expect(weightSplit).toMatch(/^Load 1's weight .* — check the line weights$/);
  });
});

describe("order entry page: the boxes a server refusal can name", () => {
  // The Add container button's id is pinned with the rest of the Containers section, below.
  it("draws every box the leaf names, with the id the leaf gives it", () => {
    const html = render({}, { index: 1 });
    const ids = [...html.matchAll(/<(?:input|select)\b[^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(Object.values(CONTAINER_KEY_BOXES).map((box) => `entry-container-c1-${box}`))
      .toEqual(ids.filter((id) => id.startsWith("entry-container-c1-")));
  });

  /** The box the part line leaf names for a refusal at `path`, on a page whose one line is `line`. */
  const lineBox = (path: string, line: { id: string; serials: { id: string; serial: string }[] }) =>
    lineRefusalField(`${path}: refused`, [line], () => true);

  it("draws every part line and serial box the line leaf names, with the id the leaf gives it (#546)", () => {
    const allowed = { allowed: true, disabled: false, title: undefined };
    const serials = [{ id: "s1", serial: "A", description: "" }, { id: "s2", serial: "B", description: "" }];
    const html = renderToStaticMarkup(<OrderLineCard index={1} isLead={false} coordinatedProcess customerChosen
      customerId="cust-1" receivedDate={undefined} ordersViewAllowed partsGate={allowed} processesGate={allowed}
      quotePickGate={allowed} onChange={() => {}} parts={[]}
      line={{ id: "L", partId: null, qty: "30", weightOverride: null, serials }} />);
    // The Part box's id is on its label, which holds the part picker.
    const drawn = [...html.matchAll(/<(input|select|label)\b[^>]*\sid="(entry-line-L-[^"]+)"/g)].map((match) => [match[1], match[2]]);
    expect(drawn).toEqual([
      ["label", "entry-line-L-part"], ["input", "entry-line-L-qty"], ["input", "entry-line-L-weight"],
      ["input", "entry-line-L-serials"],
      ["input", "entry-line-L-serial-s1"], ["input", "entry-line-L-serial-s1-description"],
      ["input", "entry-line-L-serial-s2"], ["input", "entry-line-L-serial-s2-description"],
    ]);
    // The leaf's ids, for each key of the server's line and of each serial: every one is drawn but
    // the quote list's. That list is drawn only after a fetch, which a static render never runs, so
    // it is pinned from source below.
    const line = { id: "L", serials };
    const named = [
      ...Object.keys(LINE_KEY_BOXES).map((key) => lineBox(`lines.0.${key}`, line)),
      ...[0, 1].flatMap((j) => Object.keys(SERIAL_KEY_BOXES).map((key) => lineBox(`lines.0.serials.${j}.${key}`, line))),
    ];
    expect(named).toEqual(["entry-line-L-part", "entry-line-L-qty", "entry-line-L-weight", "entry-line-L-serials",
      "entry-line-L-quote", "entry-line-L-serial-s1", "entry-line-L-serial-s1-description", "entry-line-L-serial-s2",
      "entry-line-L-serial-s2-description"]);
    expect(drawn.map(([, id]) => id)).toEqual(named.filter((id) => id !== "entry-line-L-quote"));
  });

  // Asked of the leaves with the source's own placeholder for an id, the box ids they build read as
  // the template literals the components write.
  const SOURCE_LINE = { id: "${line.id}", serials: [] };

  it("gives a line's quote id to QuoteLinkPicker, which puts it on its list alone (#546, D4)", () => {
    // The page asks the document for this id to tell whether the line's quote list is shown: the
    // picker's states that draw no list (no customer or part, no orders.view, checking, failed)
    // carry no id.
    const quoteId = lineBox("lines.0.quoteLineId", SOURCE_LINE);
    expect(quoteId).toBe("entry-line-${line.id}-quote");
    expect(jsxTags("src/app/orders/new/OrderLineCard.tsx").filter((tag) => tag.name === "QuoteLinkPicker")
      .map((tag) => tag.attr("id"))).toEqual([`\`${quoteId}\``]);
    expect(jsxTags("src/app/orders/new/QuoteLinkPicker.tsx").filter((tag) => tag.attr("id") !== undefined)
      .map((tag) => [tag.name, tag.attr("id")])).toEqual([["select", "id"]]);
  });

  it("draws every charge box the charge leaf names, with the id the leaf gives it (#546)", () => {
    const named = Object.keys(CHARGE_KEY_BOXES).map((key) => chargeRefusalField(`charges.0.${key}: refused`, ["${c.id}"], "L"));
    expect(named).toEqual([
      { tab: "details", fieldId: "entry-charge-${c.id}-description" },
      { tab: "details", fieldId: "entry-charge-${c.id}-amount" },
    ]);
    expect(jsxTags(PAGE_FILE).filter((tag) => tag.attr("id")?.startsWith("`entry-charge-"))
      .map((tag) => [tag.name, tag.attr("id")])).toEqual(named.map((answer) => ["input", `\`${answer?.fieldId}\``]));
  });
});

describe("order entry page: the create body's container rows", () => {
  it("sends each row as the leaf gives it, with what the Tare each box shows", () => {
    const containers = [
      row(),
      row({ id: "c2", typeId: "bin", count: "14", pieces: "", tareEachOverride: "" }),
      row({ id: "c3", tareEachOverride: " 50.00 ", scaleGross: "580", customerContainerId: "BIN-9" }),
    ];
    const body = actual<() => { containers: unknown[] }>("buildCreateBody", {
      draft: entryDraft(containers), adjustmentResult: { adjustment: { source: "part" } }, preview: { fingerprint: "f" },
      displayedPo: "", customerParts: [PART], computeLineWeight, containerTypes: TYPES, entryContainerBody,
    })();
    expect(body.containers).toStrictEqual([
      { typeId: "steel", count: 3, pieces: 252, tareEach: "42.5", scaleGross: null, customerContainerId: "" },
      { typeId: "bin", count: 14, pieces: null, tareEach: null, scaleGross: null, customerContainerId: "" },
      { typeId: "steel", count: 3, pieces: 252, tareEach: "50.00", scaleGross: "580", customerContainerId: "BIN-9" },
    ]);
  });
});

// ---- the page's Containers section, read ----

const tagOf = (node: ts.Node): string | undefined =>
  ts.isJsxElement(node) ? node.openingElement.tagName.getText(pageSource) : undefined;
/** What the page's Containers section draws, in order: each child's source, with every run of
 *  white space as one space. The section is the one whose heading reads Containers. */
function containersSection(): string[] {
  const found = all(pageSource, ts.isJsxElement).filter((element) => tagOf(element) === "section"
    && element.children.some((child) => tagOf(child) === "h2" && child.getText(pageSource).includes(">Containers<")));
  expect(found).toHaveLength(1);
  return found[0].children.filter((child) => !(ts.isJsxText(child) && child.text.trim() === ""))
    .map((child) => child.getText(pageSource).replace(/\s+/g, " "));
}
const shownText = all(pageSource, ts.isJsxText).map((text) => text.text).join("\n");
const literals = all(pageSource, ts.isStringLiteral).map((literal) => literal.text);

describe("order entry page: the Containers section", () => {
  it("draws each row through EntryContainerRow, with the draft row, the types and the page's refusal", () => {
    const rows = jsxTags(PAGE_FILE).filter((tag) => tag.name === "EntryContainerRow");
    expect(rows).toHaveLength(1);
    const prop = (name: string) => rows[0].attr(name);
    expect([prop("container"), prop("index"), prop("containerTypes"), prop("errorFieldIds")])
      .toEqual(["c", "i", "containerTypes", "error?.fieldIds ?? []"]);
    expect(prop("onChange")).toContain("patchContainer(c.id");
    expect(prop("onRemove")).toContain("removeContainer(c.id)");
  });

  it("keeps none of the old arithmetic, and shows no Total pieces, Qty/container or row Net", () => {
    expect(initializers(PAGE_FILE, "containerQtyValid")).toEqual([]);
    expect(all(pageSource, ts.isFunctionDeclaration).filter((f) => f.name?.text === "netWeight")).toHaveLength(0);
    for (const gone of ["Total pieces", "Qty/container", "Net:"]) expect(shownText).not.toContain(gone);
  });

  it("draws the totals table once, last and under no condition, and the P3 sentence under the packaging line", () => {
    const drawn = containersSection();
    expect(drawn).toHaveLength(7);
    expect(drawn.slice(0, 4)).toEqual([
      '<h2 className="mb-2 font-medium">Containers</h2>',
      '<p className="mb-3 text-xs text-ink-500">Customer packaging, independent of furnace loads.</p>',
      '{containerTypesFailed && <p className={`${NOTICE.warning} mb-3`}>{CONTAINER_TYPES_NOT_LOADED}</p>}',
      '{draft.containers.length === 0 && <p className="text-sm text-ink-500">None.</p>}',
    ]);
    expect(drawn[4].startsWith("{draft.containers.map((c, i) => (")).toBe(true);
    expect(drawn.slice(5)).toEqual([
      '<button id={ADD_CONTAINER_ID} type="button" onClick={addContainer} className={`${LINK} text-sm`}>Add container</button>',
      "<OrderTotalsTable totals={totals} />",
    ]);
    expect(jsxTags(PAGE_FILE).filter((tag) => tag.name === "OrderTotalsTable")).toHaveLength(1);
  });

  it("works the table out from the checked lines, each line's part, the customer's parts, the draft's rows and the type list", () => {
    const written = initializers(PAGE_FILE, "totals");
    expect(written).toHaveLength(1);
    // The page's own expression, run. One line of 30 pieces at 2.5 lb each, and three steel
    // baskets of 252 pieces on a scale at 330 lb. Each thing the page hands over moves a figure:
    // 30 and 75.00 are the checked line's, 127.50 is the type list's default, 252 and 330 are the
    // draft row's, and Implied pieces needs the line's part and that part's each weight.
    const totals = run<OrderTotalsView>(written[0], { orderTotals, entryTotalsInput,
      draft: entryDraft([row({ scaleGross: "330" })]), totalsLines: [{ partId: "part-1", qty: 30, weight: 75 }],
      customerParts: [PART], containerTypes: TYPES });
    expect(totals).toEqual({
      rows: [
        { heading: "Parts", pieces: "30", net: "75.00", tare: "", gross: "" },
        { heading: "Containers", pieces: "252", net: "", tare: "127.50", gross: "" },
        { heading: "Order", pieces: "", net: "75.00", tare: "127.50", gross: "202.50" },
      ],
      note: null,
      weighed: ["Weighed net 202.50 lb · 127.50 lb over", "Implied pieces 81 · 51 over"],
    });
  });

  // The line the table replaces (owner ruling W8). Each case fails if that text is shown again.
  it.each(["Parts: ", " · Containers: "])("no longer shows the line's text %j", (gone) => {
    expect(shownText).not.toContain(gone);
  });
  it.each(["Incomplete", "Comparison incomplete", "Quantities match", "Quantities differ — informational only"])(
    "no longer holds the line's word %j", (gone) => {
      expect(literals).not.toContain(gone);
    });
  it.each(["entryContainerPieces", "containerPieces"])("no longer names %s", (gone) => {
    expect(mentions(PAGE_FILE, gone)).toBe(0);
  });
  it("reads the page with readers that find what is there", () => {
    expect(shownText).toContain("Customer packaging, independent of furnace loads.");
    expect(literals).toContain("Pick a customer.");
    expect(mentions(PAGE_FILE, "entryTotalsInput")).toBe(2);   // its import and its one call
  });
});

describe("order entry page: when the container types cannot be read (owner ruling P3)", () => {
  /** The page's one effect that reads the container types, run over stand-ins. It answers what the
   *  effect called, in order. */
  async function readTypes(api: () => Promise<unknown>): Promise<unknown[][]> {
    const effects = all(pageSource, ts.isCallExpression).filter((call) => call.expression.getText(pageSource) === "useEffect"
      && call.arguments[0]?.getText(pageSource).includes('"/api/picklists/containerType"'));
    expect(effects).toHaveLength(1);
    const calls: unknown[][] = [];
    const called = (name: string) => (...given: unknown[]) => { calls.push([name, ...given]); };
    run<() => void>(effects[0].arguments[0].getText(pageSource), { api, setContainerTypes: called("setContainerTypes"),
      setContainerTypesFailed: called("setContainerTypesFailed"), addLoadError: called("addLoadError") })();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    return calls;
  }

  it("marks the read failed, and still passes on the read's own message", async () => {
    expect(await readTypes(() => Promise.reject(new Error("Network down"))))
      .toEqual([["setContainerTypesFailed", true], ["addLoadError", "Network down"]]);
  });

  it("marks nothing when the read lands", async () => {
    expect(await readTypes(() => Promise.resolve(TYPES))).toEqual([["setContainerTypes", TYPES]]);
  });

  it("starts unmarked, and nothing sets the mark back", () => {
    expect(initializers(PAGE_FILE, "containerTypesFailed")).toEqual(["useState(false)"]);
    expect(mentions(PAGE_FILE, "setContainerTypesFailed")).toBe(2);   // where it is declared, and the catch
    expect(mentions(PAGE_FILE, "containerTypesFailed")).toBe(2);   // where it is declared, and the sentence's condition
  });

  it("names, in its sentence, the status word the page shows once the draft is stored", () => {
    const status = renderToStaticMarkup(<DraftSaveStatus state={{ status: "saved", acknowledgedGeneration: 0 }} />);
    const word = status.match(/^<span\b[^>]*>([^<]+)<\/span>$/)?.[1];
    expect(word).toBe("Draft saved");
    expect(CONTAINER_TYPES_NOT_LOADED).toContain(`Reload the page once it reads ${word},`);
  });
});
