// New order's request-date read and the reads beside it (#664, #668, #669), and the two typeahead
// pickers' scroll (#665). vitest has no DOM and no component renderer, so each effect is lifted
// from its file's own source and run over stand-ins (tests/helpers/source-lift.ts), and the wiring
// around it is pinned from the parsed source.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { all, run } from "./helpers/source-lift";
import { jsxTags } from "./helpers/jsx-source";

function parse(file: string): ts.SourceFile {
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
/** The file's one `useEffect` whose callback holds `marker`. */
function effect(source: ts.SourceFile, marker: string): ts.CallExpression {
  const found = all(source, ts.isCallExpression).filter((call) => call.expression.getText(source) === "useEffect"
    && call.arguments[0]?.getText(source).includes(marker));
  expect(found, marker).toHaveLength(1);
  return found[0];
}
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const PAGE = "src/app/orders/new/page.tsx";
const page = parse(PAGE);
const pageText = oneLine(page.getFullText());

describe("New order's request-date read (#664)", () => {
  const read = effect(page, "/api/orders/entry-defaults");
  type Call = [string, ...unknown[]];
  /** Runs the effect once over `given`, and answers what it called, in order, once its read settled. */
  async function runRead(given: { customerId: string; ordersViewAllowed: boolean; answer?: () => Promise<unknown> }): Promise<{ calls: Call[]; paths: string[] }> {
    const calls: Call[] = []; const paths: string[] = [];
    const called = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
    let ticket = 0;
    const entryDefaultsLatest = { next: () => ++ticket, isCurrent: (t: number) => t === ticket };
    run<() => void>(read.arguments[0].getText(page), {
      customerId: given.customerId, leadPartId: "part-1", readReceivedDate: "2026-10-01", ordersViewAllowed: given.ordersViewAllowed,
      entryDefaultsLatest, URLSearchParams,
      setEntryDefaultsError: called("setEntryDefaultsError"), setEntryDefaultRequestDate: called("setEntryDefaultRequestDate"),
      api: (path: string) => { paths.push(path); return (given.answer ?? (() => Promise.resolve({ requestDate: "2026-10-08" })))(); },
    })();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    return { calls, paths };
  }

  it("a failed read shows its own message and leaves no date behind", async () => {
    const { calls } = await runRead({ customerId: "cust-b", ordersViewAllowed: true,
      answer: () => Promise.reject(new Error("That part belongs to another customer")) });
    expect(calls).toEqual([
      ["setEntryDefaultsError", null],
      ["setEntryDefaultsError", "That part belongs to another customer"], ["setEntryDefaultRequestDate", null],
    ]);
  });

  it("each run clears the last failure, and a read that lands sets the date", async () => {
    const { calls, paths } = await runRead({ customerId: "cust-a", ordersViewAllowed: true });
    expect(calls).toEqual([["setEntryDefaultsError", null], ["setEntryDefaultRequestDate", "2026-10-08"]]);
    expect(paths).toEqual(["/api/orders/entry-defaults?customerId=cust-a&partId=part-1&receivedDate=2026-10-01"]);
  });

  it("reads nothing without orders.view, or with no customer, and clears both the date and the failure", async () => {
    for (const given of [{ customerId: "cust-a", ordersViewAllowed: false }, { customerId: "", ordersViewAllowed: true }]) {
      const { calls, paths } = await runRead(given);
      expect(paths).toEqual([]);
      expect(calls).toEqual([["setEntryDefaultsError", null], ["setEntryDefaultRequestDate", null]]);
    }
  });

  it("is keyed on the debounced received date and the permission, and writes nothing to the list banner", () => {
    expect(oneLine(read.arguments[1].getText(page))).toBe("[customerId, leadPartId, readReceivedDate, ordersViewAllowed, entryDefaultsLatest]");
    expect(read.arguments[0].getText(page)).not.toContain("addLoadError");
  });

  it("shows its failure and the missing permission beside the Request date box", () => {
    expect(pageText).toContain('{customerId && perms !== undefined && !ordersViewAllowed && <p className={`mt-1 ${TEXT_MUTED}`}>{ordersViewGate.title}</p>} <PanelMessage message={entryDefaultsError} />');
    // The list reads' banner and the autosave's message each have a line of their own.
    expect(pageText).toContain("{loadError && <p className={`${NOTICE.warning} mb-3`}>{loadError}</p>} {autosaveError && <p className={`${NOTICE.warning} mb-3`}>{autosaveError}</p>}");
  });
});

describe("New order reads with a debounced received date (#668)", () => {
  it("the date the reads ask with settles 250 ms after typing, and at once when the draft becomes ready", () => {
    expect(pageText).toContain("const readReceivedDate = useDebouncedValue(draft.receivedDateOverride, SEARCH_DEBOUNCE_MS, draftReady);");
  });

  it("each line's quote preview takes it, and the box and the save keep the live value", () => {
    const cards = jsxTags(PAGE).filter((tag) => tag.name === "OrderLineCard");
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(card.attr("receivedDate")).toBe("readReceivedDate ?? undefined");
    expect(pageText).toContain("receivedDate: draft.receivedDateOverride ?? undefined,");
    expect(pageText).toContain("const displayedReceivedDate = draft.receivedDateOverride ?? formatDateOnly(todayDateOnly());");
  });
});

describe("New order's resume prompt dates its draft (#669)", () => {
  it("reads the draft's time through formatDateTime, with its date", () => {
    expect(pageText).toContain("Draft from {formatDateTime(draftPrompt.updatedAt)}");
    expect(pageText).not.toContain("toLocaleTimeString");
  });
});

describe("the typeahead pickers keep the highlighted option in view (#665)", () => {
  for (const [file, id] of [["src/components/Combobox.tsx", "activeId"], ["src/app/parts/[id]/ProcessCodeSearch.tsx", "activeOptionId"]] as const) {
    it(`${file} scrolls the list to its active option as it moves, and only while one shows`, () => {
      const source = parse(file);
      const scroll = effect(source, "scrollIntoView");
      expect(oneLine(scroll.arguments[1].getText(source))).toBe(`[${id}]`);
      const scrollIntoView = vi.fn(); const asked: string[] = [];
      const document = { getElementById: (name: string) => { asked.push(name); return { scrollIntoView }; } };
      run<() => void>(scroll.arguments[0].getText(source), { [id]: "list-3", document })();
      expect(asked).toEqual(["list-3"]);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      run<() => void>(scroll.arguments[0].getText(source), { [id]: undefined, document })();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
  }

  it("each picker's aria-activedescendant names the same option the effect scrolls to", () => {
    const combo = jsxTags("src/components/Combobox.tsx").filter((t) => t.attr("role") === "combobox");
    const search = jsxTags("src/app/parts/[id]/ProcessCodeSearch.tsx").filter((t) => t.attr("role") === "combobox");
    expect(combo.map((t) => t.attr("aria-activedescendant"))).toEqual(["activeId"]);
    expect(search.map((t) => t.attr("aria-activedescendant"))).toEqual(["activeOptionId"]);
  });
});
