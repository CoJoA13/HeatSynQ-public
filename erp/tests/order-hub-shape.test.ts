import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftStore, type DraftStore } from "@/lib/draft-store";
import { EMPTY_DRAFT_SUMMARY } from "@/lib/draft-session";
import { TravelerNoticeView } from "@/app/orders/[id]/TravelerNoticeView";
import { OrderAtAGlance } from "@/app/orders/[id]/OrderAtAGlance";
import { TravelerProvider } from "@/app/orders/[id]/DocumentsSection";
import { HUB_TAB_LABEL, orderHubTabs } from "@/lib/order-hub-tabs";
import type { NoticeOrder, NoticePrint } from "@/lib/traveler-notice";
import { buildTravelerPrintRecord, serializeTravelerPrintRecord } from "@/lib/traveler-print-record";
import { makeLatestGate } from "@/lib/use-latest";
import { jsxTags, mentions } from "./helpers/jsx-source";

// How the order hub is shaped since PR 2 of the UX redesign (spec §4.4; the quantity corrections
// design §10 for the strip and the notice): a PageHeader, seven RecordTabs over the mounted
// sections, the At-a-glance card holding the print button, the notice, the print messages and
// the reconciliation strip, Void as the title-row DangerButton and Link/Unlink in More actions.
// One `describe` for the card, one for the notice it mounts, one for the page's own shape.
//
// vitest has no DOM, and nothing renders the summary whole: it measures itself in an effect and
// its print button needs the page's print controller. So the card and the sections it links to
// are read as source, the way order-invoice-gates.test.ts reads the page. The one function here
// with behaviour of its own, `TravelerNotice`, is lifted out of its file
// and run, the way order-shipments-invalidation.test.ts runs `applyMutation`. So are two pieces of
// the print controller: its read of the document list and the effect that issues it. A lifted
// piece that gains a free identifier must gain it in the environment given here, in the same
// change.
//
// What a mounted component draws is its own suite's. Only a browser proves a scroll.

// The card's print controller reads the app router and the browser draft store: both stubbed the
// way tests/order-traveler-actions.test.tsx stubs them.
vi.mock("next/navigation", () => ({
  usePathname: () => "/orders/order-1", useRouter: () => ({ replace: () => {} }),
}));
const drafts = vi.hoisted(() => ({ store: null as DraftStore | null }));
vi.mock("@/lib/use-recoverable-draft", async original => ({
  ...await original<typeof import("@/lib/use-recoverable-draft")>(),
  useDraftIdentity: () => { const s = drafts.store?.getSnapshot() ?? EMPTY_DRAFT_SUMMARY; return { store: drafts.store, owner: s.owner, identityReady: s.identityReady }; },
  useDraftStoreAnswer: <T,>(answer: (store: DraftStore) => T, fallback: T) => (drafts.store ? answer(drafts.store) : fallback),
}));
beforeEach(() => {
  drafts.store = createDraftStore();
  drafts.store.acceptIdentity(drafts.store.beginIdentityCheck(), "traveler-user");
});

// ---- the file readers ----

const PAGE = "src/app/orders/[id]/page.tsx";
const CARD_FILE = "src/app/orders/[id]/OrderAtAGlance.tsx";
const LINES = "src/app/orders/[id]/LinesSection.tsx";
const CONTAINERS = "src/app/orders/[id]/ContainersSection.tsx";
const SERIALS = "src/app/orders/[id]/SerialsSection.tsx";

/** One file under `erp/`, parsed. */
function parse(file: string): ts.SourceFile {
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
/** The names of a file's JSX elements, in source order. */
const tagNames = (file: string) => jsxTags(file).map((tag) => tag.name);
/** The function `name` declared at the top level of `file`, closed over `environment` and nothing
 *  else. Throws unless there is exactly one: a function moved inside a component is not found.
 *  Its `export`, if it has one, is left off: an expression cannot carry it. JSX in it becomes a
 *  call to `React.createElement`, so a function that draws something needs `React` given. */
function lifted<T>(file: string, name: string, environment: Record<string, unknown>): T {
  const source = parse(file);
  const found = source.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (found.length !== 1) throw new Error(`Expected one top-level function ${name} in ${file}, found ${found.length}`);
  const body = ts.transpileModule(`return (${found[0].getText(source).replace(/^export\s+/, "")});`, {
    fileName: "lifted.tsx",
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(environment), body)(...Object.values(environment)) as T;
}
/** Every node under `root` that `is` accepts, `root` included, in source order. */
function all<T extends ts.Node>(root: ts.Node, is: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const walk = (node: ts.Node): void => { if (is(node)) out.push(node); ts.forEachChild(node, walk); };
  walk(root);
  return out;
}
/** The production expression `node`, from a file `parse` read, closed over `environment` and
 *  nothing else. Its types are dropped, and a name it reads that is not given is a ReferenceError. */
function ran<T>(node: ts.Node, environment: Record<string, unknown>): T {
  const body = ts.transpileModule(`return (${node.getText()});`, {
    fileName: "ran.tsx",
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(environment), body)(...Object.values(environment)) as T;
}
/** A promise settled from outside, for a request the test answers when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
/** Every promise reaction queued so far has run. */
const settle = () => new Promise<void>((done) => setImmediate(done));

describe("the card beside the tabs", () => {
  it("mounts the strip with no jump of its own, the notice, the print messages and one all-loads print button", () => {
    const names = tagNames(CARD_FILE);
    expect(names.filter((n) => n === "ReconciliationStrip")).toHaveLength(1);
    expect(jsxTags(CARD_FILE).find((t) => t.name === "ReconciliationStrip")?.text).toBe("<ReconciliationStrip order={order} />");
    expect(names.filter((n) => n === "TravelerNotice")).toHaveLength(1);
    expect(names.filter((n) => n === "TravelerFeedback")).toHaveLength(1);
    expect(names.filter((n) => n === "TravelerPrintButton")).toHaveLength(1);
    expect(names.filter((n) => n === "details")).toHaveLength(0);
  });

  it("draws a region named At a glance with Lead part, PO and Status, no customer link, and the print button", () => {
    const order = {
      orderNumber: 7, customerId: "c1", customer: { code: "ACME", name: "Example Company" }, poNumber: "PO-1",
      status: "OPEN", light: "on_target", voided: false,
      lines: [{ id: "a", position: 1, qty: 10, weight: 16, part: { partNumber: "P-1", name: "Pin" } }],
      containers: [{ pieces: 10, count: 1, tareEach: 42.5, scaleGross: null }],
      loads: [{ id: "load-1", loadNumber: 1, qty: 10, weight: 16 }, { id: "load-2", loadNumber: 2, qty: 0, weight: 0 }],
      serials: [], travelerPrinted: false,
    };
    const html = renderToStaticMarkup(createElement(TravelerProvider as never,
      { orderId: "order-1", loads: order.loads, voided: false, viewGate: { allowed: true, disabled: false, title: undefined }, autoPrint: false },
      createElement(OrderAtAGlance, { order: order as never })));
    expect(html).toContain('role="region" aria-label="At a glance"');
    expect([...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((m) => m[1])).toEqual(["Lead part", "PO", "Status"]);
    expect(html).not.toContain("<a ");
    expect(html).toMatch(/<button[^>]*>Print 2 travelers<\/button>/);
    expect(html).toContain('aria-label="Order quantities"');
  });
});

describe("the sections the strip links to", () => {
  // Each keeps its id, its jump marker, its focusability and the card class, so a strip link and
  // RecordTabs' hash scroll land on it.
  it.each([["lines", LINES], ["containers", CONTAINERS], ["serials", SERIALS]])("%s", (id, file) => {
    const section = jsxTags(file).find((t) => t.name === "section" && t.attr("id") === id);
    expect(section, `${file} section#${id}`).toBeDefined();
    expect(section?.attr("data-order-section")).toBeDefined();
    expect(section?.attr("tabIndex")).toBe("-1");
    expect(section?.attr("className")).toBe("`${CARD} mb-6`");
  });
});

describe("the notice in the summary", () => {
  // Under a static render the print controller's document list is always empty, so a rendered
  // notice could only ever show nothing. Where it is mounted is read from the source. What it
  // hands its view, and when it works the notice out again, is run: `TravelerNotice` is lifted
  // from its file over a stand-in controller. What the view shows is
  // tests/traveler-notice.test.ts's and tests/traveler-notice-view.test.tsx's.
  const DOCUMENTS = "src/app/orders/[id]/DocumentsSection.tsx";

  it("draws the view in one place only", () => {
    const views = jsxTags(DOCUMENTS).filter((tag) => tag.name === "TravelerNoticeView");
    expect(views.map((tag) => tag.text)).toEqual([
      "<TravelerNoticeView order={{ lines, loads, status, voided }} prints={docs} />",
    ]);
    // One import and one mount. A third mention would be a second place the notice is drawn.
    expect(mentions(DOCUMENTS, "TravelerNoticeView")).toBe(2);
  });

  describe("TravelerNotice", () => {
    // The production function, lifted from DocumentsSection.tsx and run. It is given four names
    // and no other: `React` for the element it returns, the view, the hook that reads the print
    // controller, and `useMemo`. A state or a request of its own would need a fifth, and would be
    // a ReferenceError here; a list written inline needs no name, and is caught below, where the
    // view must be handed the controller's own list.
    //
    // `useMemo` is a stand-in that keeps React's own rule for one memo: the value made last time
    // is handed back while every dependency is the same by `Object.is`, and is made again when
    // one is not. So what is proven is the dependency list: with that rule, the notice follows
    // each thing it reads. That React skips a child whose element is the very object it was
    // handed last time is React's, and is not proven here.
    const ENDING = "a quantity, a weight or the loads changed after it printed.";
    type Notice = (props: { order: NoticeOrder }) => ReactElement<{ order: NoticeOrder; prints: readonly NoticePrint[] }>;

    /** A traveler print of `printed`, as the document list carries it: of every load, or of one. */
    const printOf = (printed: NoticeOrder, loadNumber: number | null = null): NoticePrint => ({
      kind: "TRAVELER", loadNumber, travelerLoadNumbers: [],
      travelerPrintRecord: serializeTravelerPrintRecord(buildTravelerPrintRecord(
        printed, loadNumber === null ? { mode: "all" } : { mode: "loads", loadNumbers: [loadNumber] })),
    });
    /** One lead of 100 pieces in three loads, as it printed. */
    const asPrinted: NoticeOrder = {
      status: "OPEN", voided: false,
      lines: [{ position: 1, partId: "part-a", qty: 100, weight: 150 }],
      loads: [
        { loadNumber: 1, qty: 50, weight: 75 }, { loadNumber: 2, qty: 30, weight: 45 }, { loadNumber: 3, qty: 20, weight: 30 },
      ],
    };
    /** The lead corrected to 32 pieces: a line save hands the page a new array of lines. */
    const corrected: NoticeOrder = { ...asPrinted, lines: [{ position: 1, partId: "part-a", qty: 32, weight: 150 }] };

    /** `TravelerNotice` over a print controller whose list is `controller.docs`. `made` counts how
     *  often the memo made its value. `says` is the notice's sentence for an order, "" for none. */
    function mounted(controller: { docs: readonly NoticePrint[] }) {
      let kept: { dependencies: readonly unknown[]; value: unknown } | null = null;
      let made = 0;
      const useMemo = <T>(make: () => T, dependencies: readonly unknown[]): T => {
        const last = kept;
        const same = last !== null && last.dependencies.length === dependencies.length
          && dependencies.every((dependency, index) => Object.is(dependency, last.dependencies[index]));
        if (!same) {
          made += 1;
          kept = { dependencies, value: make() };
        }
        return kept!.value as T;
      };
      const notice = lifted<Notice>(DOCUMENTS, "TravelerNotice", {
        React: { createElement }, TravelerNoticeView, useTraveler: () => controller, useMemo,
      });
      const says = (order: NoticeOrder) => renderToStaticMarkup(notice({ order })).replace(/<[^>]+>/g, "");
      return { notice, says, made: () => made };
    }

    it("hands the view the print controller's own document list, and the four things of the order the rule reads", () => {
      const controller = { docs: [printOf(asPrinted)] };
      // The page's order holds more than the notice reads: header text, for one.
      const order = { ...corrected, poNumber: "PO-1" };
      const element = mounted(controller).notice({ order });
      expect(element.type).toBe(TravelerNoticeView);
      // The list itself, not a copy and not a list of this function's own.
      expect(element.props.prints).toBe(controller.docs);
      expect(Object.keys(element.props.order).sort()).toEqual(["lines", "loads", "status", "voided"]);
      expect(element.props.order.lines).toBe(order.lines);
      expect(element.props.order.loads).toBe(order.loads);
      expect(element.props.order).toMatchObject({ status: "OPEN", voided: false });
    });

    it("does not work the notice out again while the page's order changes only in what the notice does not read", () => {
      const { notice, made } = mounted({ docs: [printOf(asPrinted)] });
      const first = notice({ order: corrected });
      // A PO number typed into the header: the page spreads its order into a new object, and the
      // lines and loads in it are the arrays the server last sent.
      const typed = { ...corrected, poNumber: "PO-1" };
      const typedOn = { ...typed, poNumber: "PO-12" };
      const second = notice({ order: typed });
      const third = notice({ order: typedOn });
      // The same element each time, so the view under it has nothing new to draw.
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(made()).toBe(1);
    });

    it("follows a new document list, new lines, new loads, a new status and a void", () => {
      const controller: { docs: readonly NoticePrint[] } = { docs: [printOf(asPrinted)] };
      const { says, made } = mounted(controller);
      expect(says(corrected)).toBe(`The printed travelers for Loads 1, 2 and 3 are out of date: ${ENDING}`);

      // A document: Load 1 is printed again, and the controller's refresh lands a new list.
      controller.docs = [printOf(corrected, 1), ...controller.docs];
      expect(says(corrected)).toBe(`The printed travelers for Loads 2 and 3 are out of date: ${ENDING}`);

      // A line: the quantity is put back, in a new array of lines. Loads 2 and 3 match their
      // paper again, and Load 1's newer paper now carries the corrected figure.
      const putBack: NoticeOrder = { ...corrected, lines: asPrinted.lines.map((line) => ({ ...line })) };
      expect(says(putBack)).toBe(`The printed traveler for Load 1 is out of date: ${ENDING}`);

      // A load: Load 3 is saved a pound heavier, in a new array of loads.
      const reweighed: NoticeOrder = {
        ...putBack, loads: putBack.loads.map((load) => (load.loadNumber === 3 ? { ...load, weight: 31 } : load)),
      };
      expect(says(reweighed)).toBe(`The printed travelers for Loads 1 and 3 are out of date: ${ENDING}`);

      // The status and the void, each on an order whose lines and loads are the same arrays.
      expect(says({ ...reweighed, status: "SHIPPED" })).toBe("");
      expect(says(reweighed)).toBe(`The printed travelers for Loads 1 and 3 are out of date: ${ENDING}`);
      expect(says({ ...reweighed, voided: true })).toBe("");
      // Seven answers, each made once: no two calls in a row above were handed the same things.
      expect(made()).toBe(7);
    });
  });

  describe("the document list it reads", () => {
    // The notice compares two things the page holds: its order, and the print controller's list
    // of the order's documents. The page takes the order whole from the server with every answer
    // it accepts: a save's, a same-order scan's, the Loads section's Refresh. A print made in
    // another session is in none of those answers. So the controller reads its list again behind
    // each of them, or the notice would set the newer order against the older list (the
    // whole-branch review of 2026-10-08).
    //
    // `TravelerProvider` is not run whole: it also holds the print, its gate and the automatic
    // print. Its read of the list (`load`) and the one effect that issues it are taken from its
    // syntax tree and run, the way order-shipments-invalidation.test.ts runs the Shipments
    // section's effects. `load` runs over the real latest-wins gate and a request this file
    // answers. The effect runs under a stand-in `useEffect` that keeps React's own rule for one
    // effect: it runs after the first render, and after a later one when a dependency is not the
    // same by `Object.is`. So what is proven of the effect is its dependency list.
    //
    // Not proven here: that the page's `order.loads` is a new array with each accepted answer and
    // the same array across a key typed into the header, an optimistic patch and `onPrinted`.
    // That is read from page.tsx, where those three spread the order and every server answer is
    // set whole, its `loads` included, but for `travelerPrinted`, which `keepTravelerPrinted`
    // keeps true once the page holds it (#550), and a header field being typed into, which the
    // edit guard keeps (use-edit-guard.ts).
    type Rows = Array<{ id: string }>;
    const OLDER: Rows = [{ id: "print-1" }];
    const NEWER: Rows = [{ id: "print-2" }, { id: "print-1" }];

    /** `TravelerProvider`, its `load` callback and the effect that calls it, as syntax. */
    function provider() {
      const source = parse(DOCUMENTS);
      const components = source.statements.filter((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "TravelerProvider");
      if (components.length !== 1) throw new Error(`Expected one TravelerProvider in ${DOCUMENTS}, found ${components.length}`);
      const named = all(components[0], ts.isVariableDeclaration)
        .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "load");
      const wrapped = named.length === 1 ? named[0].initializer : undefined;
      if (!wrapped || !ts.isCallExpression(wrapped) || wrapped.expression.getText() !== "useCallback") {
        throw new Error("TravelerProvider no longer declares one `load` as a useCallback");
      }
      const calls = (root: ts.Node, name: string) => all(root, ts.isCallExpression)
        .filter((call) => ts.isIdentifier(call.expression) && call.expression.text === name);
      // Every effect of the controller that reads the list. `print` reads it too, in its
      // `finally`, and is a callback, not an effect.
      const reading = calls(components[0], "useEffect").filter((effect) => calls(effect.arguments[0], "load").length > 0);
      if (reading.length !== 1) throw new Error(`Expected one effect that calls load, found ${reading.length}`);
      return { component: components[0], load: wrapped.arguments[0], effect: reading[0] };
    }

    /** The controller's read and its effect, run. `render(loads)` is one render of the provider
     *  with the page's array of loads. `requests` is every read issued, each answered by the
     *  test. `landed` is every list handed to the state, and `errors` every archive error set. */
    function mounted() {
      const { load: callback, effect } = provider();
      const requests: Array<{ url: string; answer: ReturnType<typeof deferred<Rows>> }> = [];
      const landed: unknown[] = [];
      const errors: Array<string | null> = [];
      // Which order a read landed for (P6 step 3): the list says "Loading…" until one has.
      const loadedFor: Array<string | null> = [];
      const load = ran<() => Promise<void>>(callback, {
        latest: makeLatestGate(),
        api: (url: string) => {
          const answer = deferred<Rows>();
          requests.push({ url, answer });
          return answer.promise;
        },
        orderId: "order-1",
        setDocs: (rows: unknown) => { landed.push(rows); },
        setArchiveError: (message: string | null) => { errors.push(message); },
        setDocsLoadedFor: (key: string | null) => { loadedFor.push(key); },
      });
      let last: readonly unknown[] | undefined;
      let rendered = false;
      const useEffect = (run: () => void, dependencies?: readonly unknown[]) => {
        const before = last;
        const same = rendered && dependencies !== undefined && before !== undefined
          && before.length === dependencies.length
          && dependencies.every((dependency, index) => Object.is(dependency, before[index]));
        rendered = true;
        last = dependencies;
        if (!same) run();
      };
      const render = (loads: readonly unknown[]) => { ran<void>(effect, { useEffect, load, loads }); };
      return { render, load, requests, landed, errors, loadedFor };
    }

    it("is read when the controller mounts, not again while the loads are the array the page already had, and again when the page hands it a new one", () => {
      const { render, requests } = mounted();
      const asRead = [{ loadNumber: 1 }];
      render(asRead);
      expect(requests.map((request) => request.url)).toEqual(["/api/orders/order-1/documents"]);

      // A key typed into the PO number, an optimistic patch, a print that has just archived: the
      // page spreads its order into a new object, and its loads are the array the server sent.
      render(asRead);
      render(asRead);
      expect(requests).toHaveLength(1);

      // A save's answer, a same-order scan, the Loads section's Refresh: the page sets the
      // server's order whole. Its loads are a new array, the same loads in it or not.
      render([{ loadNumber: 1 }]);
      expect(requests.map((request) => request.url)).toEqual([
        "/api/orders/order-1/documents", "/api/orders/order-1/documents",
      ]);
    });

    it("the array it watches is the page's own: its `loads` is the prop, and the page hands it the order's loads", () => {
      const { component } = provider();
      // Every place the controller declares the name: once, in the props it destructures. A
      // local of that name would be what the effect watched, and not the page's array.
      const declarations = all(component, (node): node is ts.BindingElement | ts.VariableDeclaration =>
        (ts.isBindingElement(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name) && node.name.text === "loads");
      expect(declarations).toHaveLength(1);
      expect(declarations[0].parent.parent).toBe(component.parameters[0]);
      const mounts = jsxTags(PAGE).filter((tag) => tag.name === "TravelerProvider");
      expect(mounts.map((tag) => tag.attr("loads"))).toEqual(["order.loads"]);
    });

    it("lands the list and clears an earlier archive error", async () => {
      const { load, requests, landed, errors, loadedFor } = mounted();
      void load();
      requests[0].answer.resolve(OLDER);
      await settle();
      expect(landed).toEqual([OLDER]);
      expect(errors).toEqual([null]);
      expect(loadedFor).toEqual(["order-1"]);
    });

    it("a failed read reports its message and leaves the list as it was, so the notice keeps its last answer", async () => {
      const { load, requests, landed, errors, loadedFor } = mounted();
      void load();
      requests[0].answer.reject(new Error("Requires orders.view"));
      await settle();
      expect(landed).toEqual([]);
      expect(errors).toEqual(["Requires orders.view"]);
      expect(loadedFor).toEqual([]);
    });

    // Two reads can be in flight: the one behind an order the page has just taken, and the
    // print's own, issued when its answer arrives. The one issued last is the one that lands.
    it("a read that a newer one replaced lands nothing when it succeeds late", async () => {
      const { load, requests, landed, errors } = mounted();
      void load();
      void load();
      requests[1].answer.resolve(NEWER);
      await settle();
      requests[0].answer.resolve(OLDER); // the read issued first, answered last
      await settle();
      expect(landed).toEqual([NEWER]);
      expect(errors).toEqual([null]);
    });

    it("a read that a newer one replaced reports nothing when it fails late", async () => {
      const { load, requests, landed, errors } = mounted();
      void load();
      void load();
      requests[1].answer.resolve(NEWER);
      await settle();
      requests[0].answer.reject(new Error("socket hang up"));
      await settle();
      expect(landed).toEqual([NEWER]);
      expect(errors).toEqual([null]);
    });
  });
});

describe("the hub's shape on the order page", () => {
  const tags = jsxTags(PAGE);
  const named = (name: string) => tags.filter((t) => t.name === name);

  it("draws the title row once, the tabs once over the seven keys, the card once, and no summary", () => {
    expect(named("PageHeader")).toHaveLength(1);
    expect(named("PageHeader")[0].attr("title")).toContain("Order #${");
    expect(named("RecordTabs")).toHaveLength(1);
    expect(named("RecordTabs")[0].attr("label")).toBe("HUB_TAB_LABEL");
    expect(named("RecordTabs")[0].attr("tabs")).toContain("orderHubTabs(");
    // A traveler scan's `?load=N` opens Loads & travelers through the prop, not the hash alone: the
    // tabs' mount effect can read `window.location` before Next has written the scan's address.
    expect(named("RecordTabs")[0].attr("open")).toBe("scanOpen(scannedLoad, scanKey)");
    const panels = named("RecordTabs")[0].attr("panels") ?? "";
    for (const key of orderHubTabs([]).map((t) => t.key)) expect(panels).toMatch(new RegExp(`\\b${key}:`));
    expect(named("OrderAtAGlance")).toHaveLength(1);
    expect(named("OrderAtAGlance")[0].attr("order")).toBe("order");
    expect(mentions(PAGE, "OrderSummary")).toBe(0);
    expect(HUB_TAB_LABEL).toBe("Order sections");
  });

  it("mounts every section once, each inside the tabs' panels", () => {
    for (const name of ["LinesSection", "ContainersSection", "SerialsSection", "ChargesSection", "LoadsSection", "DocumentsSection",
      "CertificationsSection", "ShipmentsSection", "InvoicesSection", "AttachmentsSection", "HistoryPanel", "ProcessSection"]) {
      expect(named(name), name).toHaveLength(1);
    }
  });

  it("keeps Void in the title row as the danger button on its gate, and Link/Unlink in More actions", () => {
    expect(named("DangerButton")).toHaveLength(1);
    expect(named("DangerButton")[0].attr("disabled")).toBe("voidGate.disabled");
    expect(readFileSync(fileURLToPath(new URL(`../${PAGE}`, import.meta.url)), "utf8")).toContain(">Void order</DangerButton>");
    expect(named("ActionMenu")).toHaveLength(1);
    expect(named("ActionMenu")[0].attr("items")).toContain('label: "Link another order"');
    expect(named("ActionMenu")[0].attr("items")).toContain('label: "Unlink from group"');
    expect(named("details")).toHaveLength(0);
  });

  it("is drawn for every order the page has read: the only return before the shape is for no order", () => {
    const source = parse(PAGE);
    const hubs = source.statements.filter((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "OrderHub");
    expect(hubs).toHaveLength(1);
    const returns: ts.ReturnStatement[] = [];
    const visit = (child: ts.Node): void => {
      if (ts.isFunctionLike(child)) return;
      if (ts.isReturnStatement(child)) returns.push(child);
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(hubs[0], visit);
    expect(returns).toHaveLength(2);
    const early = returns[0].parent;
    expect(ts.isIfStatement(early) ? early.expression.getText() : `not an if: ${ts.SyntaxKind[early.kind]}`).toBe("!order");
  });
});
