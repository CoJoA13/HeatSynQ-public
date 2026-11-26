import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pickPatch, suggestionsFor, typedPatch } from "../src/lib/invoice-step-pick";
import type { InvoiceStepSuggestions } from "../src/lib/invoice-step-suggestions";
import { callback } from "./helpers/lift-callback";
import { jsxTags } from "./helpers/jsx-source";
import { run } from "./helpers/source-lift";

/**
 * #239 MR E — the two screen rules nothing else in the gate set can see. `tsc` and `eslint` read
 * neither class strings nor markup structure, and both defects render as perfectly valid pages.
 *
 * Both are pinned at the SOURCE rather than by render, and the split is forced rather than chosen
 * (the `row-controls.test.tsx` / `admin-screens.test.tsx` precedent from MR C and MR D): the
 * invoicing list's candidate rows and the aging report's rows both arrive from a landed fetch
 * inside a `"use client"` page that SSR never resolves, so it renders zero rows and neither rule is
 * reachable that way. The select-all LOGIC is a leaf and is proved by behaviour in
 * `select-all.test.ts`; what is left here is that the screen is actually wired to it.
 *
 * Every assertion below matches a WHOLE attribute or element rather than a bare utility name —
 * MR D's mutation 15, where a substring check over the file was satisfied by the comment beside
 * the markup while the markup itself did nothing.
 */
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), "utf8");

/** Source with its JSX/line comments removed, so no assertion below can be met by prose. */
const stripComments = (source: string) =>
  source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

/** Collapsed whitespace, for matching a multi-line JSX element as one string. */
const flat = (source: string) => source.replace(/\s+/g, " ");

// ------------------------------------------------------------------------------------------------
// C9a — the invoicing list's header select-all
// ------------------------------------------------------------------------------------------------

describe("Invoicing — the ready-to-invoice header select-all (C9a)", () => {
  const src = stripComments(read("app/invoicing/InvoicingList.tsx"));

  it("puts a named checkbox in the header cell that used to be empty", () => {
    expect(flat(src)).toContain('<input type="checkbox" ref={selectAllRef}');
    expect(src).toContain('aria-label="Select all orders ready to invoice"');
    // The `<th className="p-2"></th>` it replaced is gone — otherwise the box could have been
    // added somewhere else entirely and this file would still read as if C9a had landed.
    expect(src).not.toContain('<th className="p-2"></th>');
  });

  it("shows and writes through the leaf, rather than re-deriving either answer inline", () => {
    expect(src).toContain('import { applySelectAll, selectAllState } from "@/lib/select-all";');
    expect(src).toContain("const selectAll = selectAllState(selectableIds, ticked);");
    expect(flat(src)).toContain('checked={selectAll === "all"}');
    expect(flat(src))
      .toContain("onChange={(e) => setTicked((prev) => applySelectAll(prev, selectableIds, e.target.checked))}");
  });

  it("governs the SELECTABLE rows — every candidate row, or none when the caller may not create", () => {
    expect(src)
      .toContain("const selectableIds = createGate.allowed ? candidates.map((c) => c.orderId) : [];");
    expect(flat(src)).toContain("disabled={selectableIds.length === 0}");
  });

  it("sets `indeterminate` after commit, never during render", () => {
    // It is a DOM property with no HTML attribute, so React cannot render it; and a ref written
    // during render is what the `react-hooks/refs` rule forbids.
    expect(flat(src)).toContain(
      'useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = selectAll === "some"; }, [selectAll]);',
    );
  });

  it("leaves the ROW checkbox exactly as it was — the surface five e2e flows drive", () => {
    // `invoice-shipped-order.mjs:216`, `close-month-end.mjs:271`, `quotes.mjs:417`,
    // `reverse-shipment.mjs:210` and `receivables-apply-age-statement.mjs:91` each scope
    // `input[type="checkbox"]` to their own `<tr>` and `.check()` it, so a header box in `<thead>`
    // is invisible to them — but only while the row box keeps its markup, and in particular while
    // it stays unnamed: an `aria-label` here would be a new accessible name on a control those
    // flows' sibling assertions count by label.
    expect(flat(src)).toContain(
      '<input type="checkbox" checked={ticked.has(c.orderId)} ' +
      "disabled={!createGate.allowed} title={createGate.allowed ? undefined : createGate.title} " +
      "onChange={(e) => toggleTicked(c.orderId, e.target.checked)} />",
    );
  });

  it("names nothing else on the screen `Customer`, `Status` or either invoice-date filter", () => {
    // `invoice-shipped-order.mjs:209-212` asserts EXACTLY ONE control answers each of those four
    // labels, so a second element carrying one would red that flow rather than this file.
    const names = [...src.matchAll(/aria-label="([^"]+)"/g)].map(m => m[1]);
    // #1057: Ready to invoice's own ship-date boxes, which show on its view alone, never beside the
    // register's.
    expect(names).toEqual([
      "Ship date from", "Ship date to", "Select all orders ready to invoice", "Invoice date from", "Invoice date to",
      "Select all drafts and finalized invoices not yet printed",
    ]);
  });
});

// ------------------------------------------------------------------------------------------------
// #591 — the Invoices table's Printed column, its boxes and Print selected
// ------------------------------------------------------------------------------------------------

describe("Invoicing — Print selected (#591)", () => {
  // `printSelected` itself runs, lifted, in invoicing-list-print-selected.test.ts. What is left here
  // is the wiring a lift cannot reach: the markup, the load's prune and the mount effect.
  const src = stripComments(read("app/invoicing/InvoicingList.tsx"));
  const loadInvoices = flat(src.slice(
    src.indexOf("const loadInvoices = useCallback(async () => {"),
    src.indexOf("}, [query, showAllState, invoicesLatest]);"),
  ));

  it("puts the named header box in the Invoices table's first column, titled with the gate's reason", () => {
    expect(flat(src)).toContain(
      '<input type="checkbox" ref={printSelectAllRef} checked={printSelectAll === "all"} ' +
      "disabled={printSelectable.length === 0} title={!createGate.allowed && !editGate.allowed ? createGate.title : undefined} " +
      'aria-label="Select all drafts and finalized invoices not yet printed"',
    );
  });

  it("ticks and unticks a row's box through a pure updater over the ticks as they stand", () => {
    // The lift reaches `printSelected`, not the row box's handler, so this is what holds the untick.
    expect(flat(src)).toContain(
      "function togglePrintTicked(invoiceId: string, checked: boolean) { setPrintTicked((prev) => { " +
      "const next = new Set(prev); if (checked) next.add(invoiceId); else next.delete(invoiceId); " +
      "return next; }); }",
    );
  });

  it("shows and writes the header box through the select-all leaf, over the tickable rows on screen", () => {
    expect(flat(src)).toContain(
      "const printSelectable = invoices .filter((r) => (finalizeTickable(r) && editGate.allowed) || (printTickable(r) && createGate.allowed)) .map((r) => r.id);",
    );
    expect(src).toContain("const printSelectAll = selectAllState(printSelectable, printTicked);");
    expect(flat(src)).toContain('checked={printSelectAll === "all"}');
    expect(flat(src)).toContain("disabled={printSelectable.length === 0}");
    // The box's value is read in the handler and handed to the updater, which stays pure: React may
    // run an updater after the event, and an updater that reads the event reads it then.
    expect(flat(src)).toContain(
      "onChange={(e) => { const checked = e.target.checked; " +
      "setPrintTicked((prev) => applySelectAll(prev, printSelectable, checked)); }}",
    );
  });

  it("sets the header box's `indeterminate` after commit, never during render", () => {
    expect(flat(src)).toContain(
      "useEffect(() => { if (printSelectAllRef.current) printSelectAllRef.current.indeterminate = " +
      'printSelectAll === "some"; }, [printSelectAll]);',
    );
  });

  it("draws a row's box only while it is tickable, gated by its own action's grant and unnamed", () => {
    // #1057: one box column, a draft's box Finalize selected's (`invoicing.edit`), a finalized
    // unprinted row's Print selected's (`invoicing.create`).
    expect(flat(src)).toContain(
      '{registerTickable(inv) && ( <input type="checkbox" checked={printTicked.has(inv.id)} ' +
      "disabled={!boxGateOf(inv).allowed} title={boxGateOf(inv).allowed ? undefined : boxGateOf(inv).title} " +
      "onChange={(e) => togglePrintTicked(inv.id, e.target.checked)} /> )}",
    );
    expect(src).toContain("const boxGateOf = (row: InvoiceRegisterRow) => (finalizeTickable(row) ? editGate : createGate);");
  });

  it("shows Printed last as date and time, and spans the empty list over all ten columns", () => {
    expect(flat(src)).toContain('<th className={`${TABLE_HEAD} p-2`}>Finalized</th> <th className={`${TABLE_HEAD} p-2`}>Printed</th> </tr>');
    expect(flat(src)).toContain('<td className={TABLE_CELL}>{inv.printedAt ? formatDateTime(inv.printedAt) : ""}</td> </tr>');
    expect(src).toContain('<tr><td colSpan={10} className={`${TABLE_CELL} text-center text-ink-500`}>No invoices</td></tr>');
  });

  it("keeps the Document No link the row's only link, its failure printed under it as Create's is, then its folder sentence in amber", () => {
    // The folder sentence (the owner's ruling of 2026-10-21): a printed row's `x-print-warnings`,
    // under the link after the failure line, in the single Print's amber.
    expect(flat(src)).toContain(
      '<td className={`${TABLE_CELL} font-mono`}> <Link href={`/invoicing/${inv.id}`} className={LINK}>' +
      "{inv.documentNumber}</Link> {printErrors.has(inv.id) && ( " +
      '<p className="mt-1 max-w-xs text-xs text-red-700">{printErrors.get(inv.id)}</p> )} ' +
      "{finalizeErrors.has(inv.id) && ( " +
      '<p className="mt-1 max-w-xs text-xs text-red-700">{finalizeErrors.get(inv.id)}</p> )} ' +
      "{finalizeWarnings.has(inv.id) && ( " +
      '<ul className="mt-1 max-w-xs list-disc pl-4 text-xs text-accent-600"> ' +
      "{finalizeWarnings.get(inv.id)!.map((w, i) => <li key={i}>{w}</li>)} </ul> )} " +
      "{printWarnings.has(inv.id) && ( " +
      '<p className="mt-1 max-w-xs text-xs text-accent-600">{printWarnings.get(inv.id)}</p> )} </td>',
    );
    const row = src.slice(src.indexOf("{invoices.map((inv) => ("), src.indexOf("{invoices.length === 0"));
    expect(row.match(/<Link\b/g)).toHaveLength(1);
  });

  it("derives the ticked rows on screen once, for the title and the run alike", () => {
    expect(src).toContain("const printRows = invoices.filter((r) => printTickable(r) && printTicked.has(r.id));");
    expect(src).toContain("const ids = printRows.map((r) => r.id);");
    expect(src).toContain("const entries = printRows.flatMap((row) => {");
  });

  it("sends each print through trackedFetch in the selected mode", () => {
    expect(src).toContain(
      "const post = (id: string) => trackedFetch(`/api/invoices/${id}/print?selected=1`, { method: \"POST\" });",
    );
  });

  it("writes the tickable ids, prunes the ticks and records the applied query only on a load's current-ticket branch", () => {
    // The slice's end. Were the deps to change, its `indexOf` would answer -1 and the slice would
    // run on to the file's end, where the pin below would still find its text (#592).
    expect(src).toContain("}, [query, showAllState, invoicesLatest]);");
    // After the `return` that a superseded load takes, so a failed or superseded load does none of
    // it. The query recorded is the closure's, the one this load's request was sent with (#592).
    expect(loadInvoices).toContain(
      "if (!invoicesLatest.isCurrent(t)) return; setInvoices(data.rows); setCut(data.cut); setInvoicesError(null); " +
      "setInvoicesLoaded(true); const tickable = new Set(data.rows.filter((r) => registerTickable(r)).map((r) => r.id)); " +
      "tickableRef.current = tickable; setPrintTicked((prev) => pruneToTickable(prev, tickable)); " +
      "setAppliedQuery(query);",
    );
    // And nowhere else: the ref has this one write (`printSelected` and `finalizeSelected` only read
    // it), the register's ticks this prune and Finalize selected's after its reload (#1057), beside
    // the candidates load's own prune of Ready to invoice's ticks, the applied query this one write
    // (both exports follow it).
    expect(src.match(/tickableRef\.current =(?!=)/g)).toHaveLength(1);
    expect(src.match(/setPrintTicked\(\(prev\) => pruneToTickable\(prev/g)).toHaveLength(2);
    expect(src.match(/setTicked\(\(prev\) => pruneToTickable\(prev, applied\)\)/g)).toHaveLength(1);
    expect(src.match(/setAppliedQuery\(/g)).toHaveLength(1);
  });

  it("reads the tickable ids in the handler after the run's reload and hands them to a pure updater", () => {
    // The lift (invoicing-list-print-selected.test.ts) runs the updater at once, so a read of
    // `tickableRef.current` moved inside it passes there; React may run it later, after another load.
    expect(flat(src)).toContain(
      "await loadInvoicesRef.current(); const tickable = tickableRef.current; const ran = new Set(ids); " +
      "setPrintTicked((prev) => printTicksAfterRun(prev, ran, result.failures, tickable));",
    );
  });

  it("marks the page open on mount and gone in the effect's cleanup", () => {
    expect(flat(src)).toContain(
      "const open = useRef(false); useEffect(() => { open.current = true; return () => { open.current = false; }; }, []);",
    );
  });

  it("titles Print as one PDF as Print selected, and Finalize selected by its own grant (#1057)", () => {
    expect(flat(src)).toContain(
      "<button onClick={() => void printSelected(\"joined\")} disabled={printTitle !== undefined} title={printTitle}",
    );
    expect(flat(src)).toContain(
      "const finalizeTitle = !editGate.allowed ? editGate.title : finalizing ? \"Finalizing…\" : printing ? \"Printing…\" : " +
      'finalizeRows.length === 0 ? "Tick at least one draft first" : undefined;',
    );
    expect(flat(src)).toContain(
      "<button onClick={() => void finalizeSelected()} disabled={finalizeTitle !== undefined} title={finalizeTitle}",
    );
    expect(src).toContain("const finalizeRows = invoices.filter((r) => finalizeTickable(r) && printTicked.has(r.id));");
    expect(src).toContain('const editGate = gate(perms, "invoicing.edit");');
  });

  it("titles Print selected as Create invoices is titled, and disables it on any title", () => {
    expect(flat(src)).toContain(
      "const printTitle = !createGate.allowed ? createGate.title : printing ? \"Printing…\" : " +
      'finalizing ? "Finalizing…" : printRows.length === 0 ? "Tick at least one finalized invoice not yet printed first" : undefined;',
    );
    expect(flat(src)).toContain(
      "<button onClick={() => void printSelected()} disabled={printTitle !== undefined} title={printTitle}",
    );
    expect(src).toContain('{printing ? "Printing…" : "Print selected"}');
  });
});

// ------------------------------------------------------------------------------------------------
// #592 — both exports follow the list on screen; Export to PDF
// ------------------------------------------------------------------------------------------------

describe("Invoicing — Export to Excel and Export to PDF follow the list on screen (#592)", () => {
  // The query each link exports is recorded by the load (pinned in the #591 describe above, beside
  // the prune); what is left here is the state it starts from and the two links that read it.
  const src = stripComments(read("app/invoicing/InvoicingList.tsx"));

  it("starts with no applied query, so neither link is live until a load has landed", () => {
    // `null`, never "": "" equals the default empty filter query, so a failed first load would read
    // as exportable (src/lib/report-export-state.ts's header).
    expect(src).toContain("const [appliedQuery, setAppliedQuery] = useState<string | null>(null);");
    expect(src).toContain('import { exportState } from "@/lib/report-export-state";');
    expect(src).toContain("const { exportable } = exportState(appliedQuery, query);");
  });

  it("draws both links through ExportLink on the applied query, PDF beside Excel and Print selected after", () => {
    expect(src).toContain('import { ExportLink } from "@/lib/report-ui";');
    expect(flat(src)).toContain(
      '<ExportLink base="/api/invoices/export" query={appliedQuery} ready={exportable} /> ' +
      '<ExportLink base="/api/invoices/register" query={appliedQuery} ready={exportable} label="Export to PDF" /> ' +
      '<div className="ml-auto flex flex-wrap items-center gap-2">',
    );
    // The Excel `<a>` built from the live filter query is gone, and nothing else links an export.
    expect(src).not.toContain("/api/invoices/export${query");
    expect(src.match(/<ExportLink\b/g)).toHaveLength(2);
    expect(src.match(/\/api\/invoices\/(export|register)\b/g)).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------------
// S3 — the wiring `operational-formatting.test.tsx` cannot see
// ------------------------------------------------------------------------------------------------

describe("Invoice detail — the finalized lines branch is actually wired to the status (S3)", () => {
  const src = stripComments(read("app/invoicing/[id]/InvoiceDetail.tsx"));

  it("hands `InvoiceLinesGrid` the invoice's own finalized flag", () => {
    // `renderToStaticMarkup` in operational-formatting.test.tsx drives the GRID directly and passes
    // `readOnly` itself, so every case there stays green with the call site below flipped to a
    // constant `false` — the branch would be dead in the product and nothing would say so. The
    // prop is required, so tsc catches its DELETION; only this catches its being lied to.
    expect(src).toContain('const finalized = invoice?.status === "FINALIZED";');
    expect(flat(src)).toContain("<InvoiceLinesGrid invoiceId={id} lines={invoice.lines}");
    expect(flat(src)).toMatch(/<InvoiceLinesGrid\b[^>]*\breadOnly=\{finalized\}/);
  });

  it("renders the frozen lines from the server's own array, never the composed overlay rows", () => {
    // The frozen-paper rule (CLAUDE.md): an invoice's snapshot columns are read unconditionally.
    // `lines` is also on screen at first paint, where `grid.rows` waits for the recovery read.
    expect(src).toContain('const paperPartOps = lines.filter((l) => l.kind === "PART" || l.kind === "OPERATION");');
    expect(src).toContain('const paperOthers = lines.filter((l) => l.kind !== "PART" && l.kind !== "OPERATION");');
  });

  it("keeps the grid hook mounted on both branches", () => {
    // Deliberate, and load-bearing for three sweeps: `tests/draft-recovery-census.test.ts` pins
    // every `useBulkGrid` to its own Discard callback, and the unsaved-registration and
    // archival-gate sweeps read this file's `SaveButton` and gate bindings. A finalized invoice
    // projects `editable: false`, so the hook's view is never "editing" — `grid.dirty` is false
    // and no unsaved section is registered whether the SaveButton renders or not.
    expect(src).toContain("const grid = useBulkGrid(lines, toLineFields, invoiceBulkOptions(recoverySource, invoiceId));");
    // No early return that would skip the hook on the frozen branch (which React forbids anyway,
    // but the sweeps above read the SOURCE and would go on passing while the product changed).
    expect(src).not.toMatch(/if\s*\(\s*readOnly\s*\)[\s\S]{0,40}return/);
    // The recovery notice is the one control the frozen branch must NOT take away: it is where a
    // retained copy from before the finalize is discarded, so it stays outside the `!readOnly`.
    expect(flat(src)).toContain("{grid.recoveryNotice && <DraftRecoveryNotice {...grid.recoveryNotice} />}");
  });
});

// ------------------------------------------------------------------------------------------------
// #587 — what the operation description box's handlers write, which a static render never runs
// ------------------------------------------------------------------------------------------------

describe("Invoice detail — the operation description box is wired to the leaf (#587)", () => {
  // operational-formatting.test.tsx renders the box closed and runs no handler, so it stays green
  // with `onPick` writing a typed patch, or with the box handed no suggestions. These run the
  // grid's own attribute expressions, parsed out of the source, over the real leaf functions.
  const boxes = jsxTags("src/app/invoicing/[id]/InvoiceDetail.tsx").filter((tag) => tag.name === "StepWordsBox");
  const row = { key: "il-1", isNew: false, orderLineId: "ol-1", pricePer: "" };
  const ageHarden = { id: "code-ah", code: "AH", name: "Age Harden" };
  const temper = { id: "code-temp", code: "TEMP", name: "Temper" };
  /** The page's saved lines (`lines`), the row's own (id `il-1`, its key) second: a decoy first
   *  holds the same words under the opposite mark, so only a find by the row's key reads "false". */
  const savedLines = (description: string) => [
    { id: "il-0", description, wordsChosen: true },
    { id: "il-1", description, wordsChosen: false },
  ];

  it("is mounted once", () => {
    expect(boxes).toHaveLength(1);
  });

  it("the page hands the grid the invoice's own kind and its suggestions read", () => {
    // Both are props a render test passes itself: `kind` is required, so tsc catches its deletion,
    // and `stepSuggestions` is optional, so nothing else sees either being dropped or lied to.
    const grids = jsxTags("src/app/invoicing/[id]/InvoiceDetail.tsx").filter((tag) => tag.name === "InvoiceLinesGrid");
    expect(grids.map((tag) => [tag.attr("kind"), tag.attr("stepSuggestions")])).toEqual([["invoice.kind", "stepSuggestions"]]);
  });

  it("a pick writes the leaf's pick onto the row: on a Needs price row, the step code and a cleared GL account too", () => {
    const patchFields = vi.fn();
    run<(s: typeof ageHarden) => void>(boxes[0].attr("onPick")!, { patchFields, pickPatch, row, lines: savedLines("Needs price") })(ageHarden);
    expect(patchFields.mock.calls).toEqual([[row, {
      description: "Age Harden", processStepCodeId: "code-ah", glAccountId: "", glAccountName: "", wordsChosen: "true" }]]);
  });

  // #587 fix wave (F1): the grid hands the leaf the row itself, so a priced row's pick sets the
  // words and the mark only, never the step code or a cleared GL account. The case above is a
  // Needs price row, where a grid passing any row with an empty `pricePer` reads the same.
  it("a pick on a priced row writes the words and the mark only", () => {
    const patchFields = vi.fn();
    const priced = { ...row, pricePer: "EACH" };
    run<(s: typeof ageHarden) => void>(boxes[0].attr("onPick")!, { patchFields, pickPatch, row: priced, lines: savedLines("Op A") })(ageHarden);
    expect(patchFields.mock.calls).toEqual([[priced, { description: "Age Harden", wordsChosen: "true" }]]);
  });

  // #587 fix wave (F5): a priced row picked back to its own saved words takes that line's mark, read
  // by the row's key.
  it("a pick of a priced row's own saved words takes the saved line's mark, found by the row's key", () => {
    const patchFields = vi.fn();
    const priced = { ...row, pricePer: "EACH" };
    run<(s: typeof ageHarden) => void>(boxes[0].attr("onPick")!, { patchFields, pickPatch, row: priced, lines: savedLines("Age Harden") })(ageHarden);
    expect(patchFields.mock.calls).toEqual([[priced, { description: "Age Harden", wordsChosen: "false" }]]);
  });

  it("a keystroke writes the text and the mark", () => {
    const patchFields = vi.fn();
    run<(value: string) => void>(boxes[0].attr("onType")!, { patchFields, typedPatch, row, lines: savedLines("Needs price") })("Age harden, rush");
    expect(patchFields.mock.calls).toEqual([[row, { description: "Age harden, rush", wordsChosen: "true" }]]);
  });

  // #587 fix wave (F5): text typed back to the row's own saved words takes that line's mark, read by
  // the row's key (the decoy before it holds the same words, marked).
  it("a keystroke typing back the row's own saved words takes the saved line's mark, found by the row's key", () => {
    const patchFields = vi.fn();
    run<(value: string) => void>(boxes[0].attr("onType")!, { patchFields, typedPatch, row, lines: savedLines("Needs price") })("Needs price");
    expect(patchFields.mock.calls).toEqual([[row, { description: "Needs price", wordsChosen: "false" }]]);
  });

  it("is handed its own order line's suggestions from the page's read", () => {
    const stepSuggestions: InvoiceStepSuggestions = { byOrderLine: { "ol-1": [temper], "ol-2": [ageHarden] }, others: [ageHarden, temper] };
    expect(run(boxes[0].attr("suggestions")!, { suggestionsFor, row, stepSuggestions })).toEqual([temper, ageHarden]);
  });

  it("patchFields sends the patch to the row's own overlay: an added row's, or a saved row's", () => {
    const grid = { updateAdded: vi.fn(), updateExisting: vi.fn() };
    const patchFields = callback<(r: { key: string; isNew: boolean }, patch: object) => void>(
      "app/invoicing/[id]/InvoiceDetail.tsx", "InvoiceLinesGrid", "patchFields", { grid });
    patchFields({ key: "il-1", isNew: false }, { description: "a" });
    patchFields({ key: "client-1", isNew: true }, { description: "b" });
    expect(grid.updateExisting.mock.calls).toEqual([["il-1", { description: "a" }]]);
    expect(grid.updateAdded.mock.calls).toEqual([["client-1", { description: "b" }]]);
  });
});

// ------------------------------------------------------------------------------------------------
// The aging export row — MR A's C9b, applied to the report it left out
// ------------------------------------------------------------------------------------------------

describe("A/R aging — the Export in the header (PR 7)", () => {
  const aging = stripComments(read("app/receivables/aging/AgingReport.tsx"));

  it("keeps the Net note adjacent to the table it explains, below the filter card", () => {
    // Duo review on AgingReport.tsx:147 (C9b): the note is a caption for the table's Net column,
    // so nothing stands between it and the table wrapper. The export row above it went to the
    // page header with PR 7 of the UX redesign.
    const NOTE = '<p className="mb-2 text-sm text-ink-500">Unapplied credit and cash reduce Net.</p>';
    const filterAt = aging.indexOf('<div className="flex flex-wrap items-end gap-3 text-sm">');
    const noteAt = aging.indexOf(NOTE);
    const tableAt = aging.indexOf("overflow-x-auto");
    expect(filterAt).toBeGreaterThan(-1);
    expect(noteAt).toBeGreaterThan(filterAt);
    expect(tableAt).toBeGreaterThan(noteAt);
    expect(aging.slice(noteAt + NOTE.length, tableAt).trim()).toBe('<div className={`${CARD_FLUSH}');
  });

  it("keeps the link itself a link — same href, same words — now in the header's action slot", () => {
    expect(flat(aging)).toContain(
      '<a href={`/api/receivables/aging/export?${query}`} className={BUTTON_NEUTRAL}>Export to Excel</a>',
    );
    expect(aging.indexOf("Export to Excel")).toBeLessThan(aging.indexOf("Unapplied credit and cash reduce Net."));
  });
});
