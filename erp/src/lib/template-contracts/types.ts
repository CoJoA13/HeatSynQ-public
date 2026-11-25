/**
 * The template-contract machinery (Phase 7 spec §5.3) — the typed source of truth the editor
 * renders from, the zod config schema is generated from, and every builder consumes a validated
 * `TemplateConfig` through.
 *
 * CLIENT-SAFE BY CONTRACT: nothing under `src/lib/template-contracts/` may import from
 * `src/server/**` (the `permission-constants.ts` precedent) — the editor imports these modules
 * from client components, and a server import would drag Prisma and `node:async_hooks` into the
 * browser bundle. That is also why `CONTENT_WIDTH` below re-declares the 564pt constant the
 * builders each already carry, instead of importing one: the `src/proxy.ts` SESSION_COOKIE rule —
 * keep the literals in sync by hand.
 *
 * Two kinds of refusal, deliberately distinct:
 *  - shape problems (unknown keys, bad enums, out-of-range values) surface as `ZodError` from the
 *    generated schema — `handle()` already turns those into clean 400s;
 *  - contract-rule problems (hiding a locked element, moving a pinned section, blowing a table's
 *    width budget, duplicate entries) throw `TemplateConfigError` with a message that names the
 *    rule — spec §5.6's "the editor alone is not the enforcement".
 *
 * THE §5.3 BACKFILL is the load-bearing behavior: `validateContractConfig` parses a stored config
 * and applies the contract's defaults for every absent key — scalar knobs via zod `.default()`,
 * missing section/field entries re-inserted at their contract position — so a version stored
 * before a knob existed keeps rendering identically as contracts grow. The parse result is always
 * a COMPLETE `TemplateConfig` — every key present, scalar knobs concrete — but a field's
 * `label: null`/`width: null` is a SENTINEL meaning "the contract's default", which builders and
 * the width check resolve at render/validation time: those two defaults stay live past the
 * parse (the evolution warning below).
 *
 * THE BACKFILL ONLY COVERS GROWTH, so contracts evolve additively (#103) — and "additive" is a
 * SEMANTIC test, not a syntactic one: every config valid under the old contract must stay valid
 * AND keep rendering the same paper under the new one. Published versions are immutable and live
 * only in each deployed database, so the repo alone cannot prove no stored config is affected;
 * an invalidated config is re-validated at print-time dereference (`template-assignments.ts`
 * `dereference` → `validateConfig`), which single-document print routes surface raw along the
 * two-kinds split above (`TemplateConfigError` → 500, `ZodError` → 400) and batch flows (the
 * per-division statement print) catch per member, reporting that member failed — either way,
 * previously-valid paper no longer prints. SAFE under the test, PROVIDED the new defaults are
 * rendering-neutral for existing configs (a new knob must default to the prior hardcoded
 * behavior — the §5.3 DEFAULT_CONFIG convention; a new field or section backfills VISIBLE, so it
 * lands on every stored config's next print and must be intended for all templates, published
 * ones included): a new knob, a new removable non-column field, a new section of such fields, a
 * widened enum, a raised budget (within the physical width it models), removable false→true —
 * the defaults and the backfill absorb them (the knob/field direction is pinned by the
 * synthetic cases in `tests/template-contracts.test.ts` — parsing and default insertion, not
 * output). NOT safe, INCLUDING the additive-looking cases: a removed
 * or renamed field key (saves store the complete validated parse, so any config saved while the
 * key existed still carries the entry); a narrowed enum or a lowered `tableBudget` (bites
 * exactly the configs using a dropped value, or totals above the new budget); a new lock —
 * removable→false, hideable→false, newly pinning a section, or a new NON-removable field inside
 * a hideable section (a stored config hiding that section now shelters a locked field, which
 * `assertLocksHonored` refuses); a new visible COLUMN on an existing table — it backfills
 * visible contributing exactly its `defaultWidth` (a config saved before the field existed
 * cannot carry an override for it; `"*"` counts 0), so every stored config's total grows by
 * that much, and a table without that much physical headroom cannot absorb it (raising
 * `tableBudget` past the width the paper can print only disables the overflow guard); and
 * CHANGING any existing contract default: a stored config pins only what it explicitly stores
 * (a present key, a non-null label or width) — everything else re-resolves against the CURRENT
 * contract at every print, an absent scalar key through the schema's `.default(...)` exactly
 * like a stored-`null` `defaultLabel`/`defaultWidth` or a text block's default — so a contract
 * default, once published against, is immutable IN EFFECT: changing one silently relabels,
 * resizes, or restyles the next print of every published version relying on it (the §5.3
 * identical-render promise, broken without any refusal), and a raised `defaultWidth` grows
 * stored totals, which can trip the width refusal. If a change that
 * affects (or cannot be ruled out for) stored configs is ever genuinely required, the two
 * sanctioned shapes are: validate AND resolve a stored config against the contract version it
 * was PUBLISHED under (which preserves its defaults too), or make print-time dereference
 * degrade gracefully (log + contract defaults for the offending elements) rather than throw.
 *
 * THE THIRD CASE, and the first one exercised (#162, owner ruling 2026-08-19): a default
 * whose current text is simply WRONG — the statement's finance-charge label read as a levied
 * charge above a Total Due that excludes it. Reaching every published version is then the POINT,
 * not the hazard, and neither sanctioned shape above applies because both preserve the old paper.
 * What makes it safe is timing, not mechanism: it landed while nothing had published a custom
 * statement template, so it changed no paper anyone had designed. Cite this as licence only under
 * the same two conditions — the existing default is wrong rather than merely improvable, AND no
 * published version depends on it yet.
 *
 * THE FOURTH CASE (owner ruling W14, 2026-10-09; the weights design §13): a built-in label that is
 * not wrong but renamed, with published versions relying on it. W14 has a renamed label reach paper
 * by a change to the built-in wording, and the words are the ones the owner approved on 2026-10-11
 * (the design's §13.3). The labels that name a weight changed in place on the traveler, both
 * shipping tickets, the certification, the invoice and the quote. Two count headings that name no
 * weight changed with them, both to "Containers": the traveler's `container_qty` (the design's §6)
 * and the two tickets' `container_count` (owner answer 10 of 2026-10-11). Editor names changed as
 * well, of weight fields and of those two count fields, on the bill of lading too (answer 11 of
 * 2026-10-11). A changed label is "CHANGING any existing contract default" from the list above,
 * done on purpose: a version whose label box was left empty prints the new word from its next
 * print. What bounds it is what a stored config holds. It holds a label only where someone typed
 * one, and a typed label prints as typed, one typed to equal the old wording included. The
 * documents' templates tests hold all three on configs stored in the shape of before the change:
 * the seed migration's literal and tests/fixtures/stored-configs-before-weights-paper.json. No key,
 * flag, width or budget moved with a label. Cite this as licence for nothing: a built-in label
 * changes again only on an owner ruling that names it. The builders changed under the same design,
 * and with them what a stored config prints where it shows a cell's column and its section. Every
 * printed weight value carries its unit (owner ruling W15, 2026-10-09), and a sum of weights past
 * the ceiling of `src/lib/net-weight.ts` prints no figure. Two existing cells changed in more than
 * those two ways. The traveler's `gross_weight` cell holds the order's net, tare and gross as three
 * lines where it held one figure (owner answer 4, 2026-10-11). The bill of lading's
 * `freight_weight` cell holds two lines where it held one figure: the shipment's gross when it has
 * one, where it printed the net, and under it the word that says which (answers 1 and 6). Each is
 * more than a changed label, and no licence either. The two ticket contracts also gained fields
 * (owner ruling W16 of 2026-10-09). `total_tare` and `total_gross` are new removable fields that
 * are not columns, which the list above calls safe. `container_tare` (answer 3 of 2026-10-11) is a
 * new column on an existing table, backfilled shown, which the list above calls not safe, so it
 * shares width (`"*"`, which counts 0 toward a total): a fixed width would be added to the total of
 * every stored config that shows the table and the column, and could refuse one, though a column
 * that shares width can still push a stored table past the right margin, which a committed case
 * holds for the frozen config with Container Type typed at 130 points.
 *
 * THE FIFTH CASE (owner ruling of 2026-10-20, #590): a builder change, W15's kind, with nothing in
 * the contract changed. The invoice's order strip prints its four fields, Our Order #, Your PO #,
 * Material and Process, on one line, where it printed two lines of two, and every stored invoice
 * and credit-memo template, published ones included, prints it so from its next print, with no
 * switch. No key, flag, width or budget moved: the `order_strip` section keeps its five fields and
 * only its comment changed. What a stored config holds still applies. A typed label prints as typed
 * (a line break in one of the four as one space, below), a hidden field drops its pair, and a blank
 * value keeps its label. The four print in their fixed order whatever order a config keeps them in,
 * as they did on two lines. The builder hands the row to render.ts under the id
 * `invoice-order-strip`, and render.ts measures each field and fits the row to the line
 * (`fitMeasuredRows`). The owner's amendment of 2026-10-21 changed two things more, again with
 * nothing in the contract changed: a line break in one of the four values or their typed labels
 * prints as one space (`lineBreaksAsSpaces`, src/lib/line-break.ts), and where a field's
 * share of the line would be under 60 points (`MEASURED_ROW_FLOOR` in render.ts; a stored `col_qty`
 * set very wide) the shown fields print one to a line instead. tests/invoice-pdf.test.ts prints the
 * one line through the seed migration's literal, and holds a typed label printed as typed and a
 * hidden field's pair dropped on a rendered page ("prints a typed label as typed and drops a hidden
 * field's pair, the other fields on one line"). On a canvas (the invoice canvas design of
 * 2026-11-10, approved on #954, the ruling that names it; PR 2 of its lane) the row keeps its id
 * as an item of its block's inner stack, in a block whose id starts with `CANVAS_TABLE_ID_PREFIX`
 * (src/server/pdf/canvas-nodes.ts), and render.ts measures it there, against the width the
 * block leaves; the flow's paper is unchanged, its row still top-level, which
 * tests/invoice-flow-oracle.test.ts holds to the definitions frozen before the change. Cite this
 * as licence for nothing: the strip changes again only on an owner ruling that names it.
 *
 * THE SIXTH CASE (owner ruling of 2026-10-20, #589): a builder change, W15's kind, with nothing in
 * the contract changed. The invoice's prices print grouped by their part line, in the PARTS list's
 * order, where they printed as one list: each group holds the prices tied to that part by their
 * saved parent, the prices that lost their part (a parent that is null, off the invoice or not a
 * PART line) print last as a group of their own, and a thin solid rule runs from margin to margin
 * after each group that printed something. A part with no prices prints no group and no rule, no
 * group is named, and nothing keeps a group together across a page break, so a rule can print alone
 * at the top of the next page. Every stored invoice and credit-memo template, published ones
 * included, prints them so from its next print, with no switch. No key, flag, width or budget moved:
 * the `price` section keeps its seven fields and only its comment changed. What a stored config holds
 * still applies. A hidden `price` section prints nothing, rules included; a hidden field prints
 * nothing, as before, and a group that draws nothing (every column heading hidden and no detail line
 * shown) is followed by no rule; a hidden PARTS section leaves the groups and their rules printing.
 * The owner's paper look of 2026-10-21 kept the rule as shown: 0.5 point, solid black, 4 points
 * above it and 1 below, and alone at the top of the next page where a break puts it there. The
 * owner's answer of the same day, after the review: the rule that ends the content (every section
 * after PRICE hidden or printing nothing, as with Totals hidden or ordered above PRICE) has no space
 * below it, because its 1 point made pdfmake start a blank last page where the last group ended 4
 * to 5 points above a page's foot. Ending under 4 points above it, the rule still prints alone on a
 * new last page, its top margin not fitting either. Both need content already past one page: where
 * only the rule, or before this answer its 1 point, runs onto page 2, `renderPdf` lays the invoice
 * out again, as it does whenever the first layout runs past one page, with a 40-point top margin in
 * place of 24 on every page, page 1 included, and those 16 points move the end of the last group
 * onto page 2 with the rule. tests/invoice-pdf.test.ts holds the rules on rendered pages ("a rule
 * after each part's prices on the printed page (#589)": the seed migration's literal and the frozen
 * typed-label config among them, "seven parts over two pages: the last group's rule prints alone at
 * the top of page 2, above Sub Total" and "with Totals hidden, a last group ending 4.47 points
 * above the page foot prints no blank last page") and each price's part on real invoices ("each
 * price row carries its part (#589)"); tests/invoice-templates.test.ts holds the definition
 * ("buildInvoiceDefinition: each part's prices, then a rule (owner ruling of 2026-10-20, #589)",
 * its nested "the rule that ends the content" among them). On a canvas (the invoice canvas design
 * of 2026-11-10, the ruling that names it; PR 2 of its lane) every rule still runs from margin to
 * margin, its offset back to the left margin taken from the price block's drawn x
 * (`priceRule(below, x1, length)`, `InvoiceCtx.priceRule`), and an end-of-block belt in
 * src/server/invoice-canvas.ts takes the last rule's 1 point off when nothing that prints follows
 * the price block; the flow's paper is unchanged (tests/invoice-flow-oracle.test.ts), and
 * tests/invoice-canvas.test.ts holds the canvas's. Cite this as licence for nothing: the price
 * block changes again only on an owner ruling that names it.
 *
 * THE SEVENTH CASE (owner ruling R14 of 2026-10-22, #671, built 2026-11-07): a builder change,
 * W15's kind, with nothing in the contract changed. A customer's default BILL_TO address row's
 * Name printed three ways; now every document stacks it above the customer's name, the quote's
 * form, skipped when blank or equal to the customer's, through one server leaf
 * (src/server/party-address.ts). On the shipping ticket the Sold To box prints one line more,
 * the row's name in bold above the customer's (`TicketParty.attn`), and on the certification the
 * To block does the same (`CertParty.attn`); the invoice's and the statement's Bill To blocks
 * stack where they replaced the customer's name; the quote is unchanged. No key, flag, width or
 * budget moved, and no contract field: the `sold_to` and `to` sections keep their fields. The
 * ticket's one-line tear-off Sold To keeps the customer's name alone, so the #522 measurement's
 * inputs are untouched. tests/shipping-ticket-templates.test.ts ("the Sold To box stacks the
 * bill-to row's name above the customer's (R14, #671)") and tests/cert-templates.test.ts ("the To
 * block stacks the bill-to row's name above the customer's (R14, #671)") hold the rendered pages,
 * tests/party-address.test.ts the rule. Cite this as licence for nothing: a party block changes
 * again only on an owner ruling that names it.
 *
 * THE EIGHTH CASE (owner ruling (b) of 2026-11-13, #943, built 2026-11-15): a builder change,
 * W15's kind, with nothing in the contract changed. The bill of lading's TRV list joins its order
 * numbers with a comma and a zero-width space (U+200B), where it joined them with a bare comma that
 * made the list one token pdfmake could not break: a long list now wraps after a comma inside its
 * column and pushes the delivering carrier and everything below it down, on every stored bill of
 * lading template, published ones included, from its next print, with no switch, and on a canvas
 * the TRV block grows by the same lines (since #971 a canvas had broken the token mid-number). A
 * one-line list prints at the width and place it had. No key, flag, width or budget moved: the `trv`
 * section keeps its one field. tests/bol.test.ts ("buildBolDefinition: the TRV order list wraps")
 * and tests/bol-canvas.test.ts ("the TRV block's list wraps") hold the rendered pages. Cite this as
 * licence for nothing: the TRV list changes again only on an owner ruling that names it.
 *
 * THE NINTH CASE (owner ruling R-B of 2026-11-17, #991): a rule that TIGHTENS, run at print time. A flow config whose
 * column table's fixed widths, with the cell padding and rules its layout adds and one 4.5 pt grid step where a "*"
 * column is shown, pass its budget, or whose invoice totals lines (their 200 pt label, two 6 pt gaps and the Amount
 * column) pass the content width, is refused by `validateConfig` (`printedBudgetProblems`,
 * ./printed-budget.ts), so a stored version that passes it no longer prints. The tables it refuses printed past the
 * right margin (under the column clamp, #991, they would print with their flexible columns a glyph a line). It landed
 * after the stored-template listing (`scripts/check-stored-templates.ts`) found no version on `.182` or the laptop dev
 * install it refuses (#991 ledger). Cite this as licence for nothing: a print-time rule tightens again only on an owner
 * ruling that names it, after the same listing.
 *
 * THE TENTH CASE (owner rulings R1 and R2 of 2026-11-24, design
 * docs/superpowers/specs/2026-11-24-bol-captions-ship-from-design.md): the bill of lading prints every line's
 * name to its left. The `carrier_name` default label changes from "(Name of Carrier)" to "Name of Carrier"
 * (W14's kind: a version with the label box empty prints the new words; a typed label prints as typed, and the
 * stored-template listing names one typed as the old wording), and prints beside its rule in the consignee
 * labels' column, where it printed as a caption under it; on a canvas its family is a ruled pair with a least
 * width (78.5 pt) a stored box narrower than which is refused at print, read off the listing before the merge.
 * The freight sidebar's furniture ("Signature of consignor", "RECEIVED $", "Agent or Cashier", "Per", "$")
 * prints beside its rules, and the Ship-from line is one sentence, its address on one line (`oneLineAddress`,
 * src/lib/line-break.ts), where it was four fixed columns; both on every stored bill of lading template,
 * published ones included, from its next print. tests/bol.test.ts and tests/bol-canvas.test.ts hold the
 * rendered pages. Cite this as licence for nothing: these lines change again only on an owner ruling that
 * names them.
 *
 * THE CANVAS KEY (owner rulings of 2026-11-07, #926; built in three PRs: #929 the model, #930 the
 * paper, #931 the designer; widened to the shipping ticket by the design of 2026-11-08, approved on
 * #935, to the bill of lading by the design of 2026-11-09, approved on #941, to the
 * certification by the design of 2026-11-10, approved on #945, to the invoice and credit memo
 * by the design of 2026-11-10, approved on #954, to the customer statement by the design of
 * 2026-11-11, approved on #964, and to the quotation by the design of 2026-11-12, approved on
 * #973): an optional top-level `layout`,
 * null by default and null on every stored, seeded and published config, the safe shape, and
 * accepted only on a contract that declares a CANVAS PROFILE (`canvas: CanvasProfile`, below): the
 * traveler's; the two shipping tickets', whose paper prints a canvas through
 * src/server/shipping-ticket-canvas.ts (PR 2a of the ticket lane); the bill of
 * lading's (`BOL_CANVAS`, PR 1 of its lane), which admits a block keyed by a field (`keyed`), the
 * width a block keeps beside its columns (`beside`), a toggle (`toggles`), the wordings a block
 * prints itself (`textBlocks`), the least widths (`leastWidths`) and the fields the stage draws on
 * a rule (`ruledFields`, PR 2; each entry carries its drawing, owner ruling (a) of 2026-11-10), and
 * whose paper prints through src/server/bol-canvas.ts and whose designer is offered (PR 2 of its
 * lane, the seed in src/server/bol-canvas-seed.ts); the certification's (`CERT_CANVAS`, PR 1
 * of its lane: seven blocks, no new profile entry, and one more `profileProblems` clause, every
 * field a rows or list block prints in `notFields`), whose paper prints through
 * src/server/cert-canvas.ts and whose designer is offered (PR 2 of its lane); the invoice's
 * (`INVOICE_CANVAS`, PR 1 of its lane: six blocks, a column table naming the contract table its
 * columns belong to (`columnTable`), rows blocks printing under that table's grid (`grid`, read
 * by its left edge, its right or every column, `gridEdge`, with the points between its columns,
 * `gridGap`, PR 2) and warning (g) on one drawn out of line with it), whose paper prints through
 * src/server/invoice-canvas.ts and whose seed is src/server/invoice-canvas-seed.ts (PR 2 of its
 * lane), and whose designer is offered and whose canvas prints through `printInvoice` and
 * `printSelectedInvoice` (PR 3 of its lane); the statement's (`STATEMENT_CANVAS`, PR 1 of its
 * lane: five blocks, nothing required, no barcode, and one more plain-data entry, `holdsHeight`, on
 * the Bill To, a block keyed by its field that is to print at least its drawn height, held where it
 * stands by one more `profileProblems` clause and read by the statement's own `tableBlock` at print
 * and `seedStatementItems` at the seed), whose paper prints through src/server/statement-canvas.ts
 * and whose seed is src/server/statement-canvas-seed.ts, and whose designer is offered and whose
 * canvas prints through `printStatementInTx` on every statement path (PR 2 of its lane); and the
 * quotation's (`QUOTE_CANVAS`, PR 1 of its lane: six blocks, nothing required, no barcode, no new
 * profile entry and no new `profileProblems` clause; its lines a rows block under the column
 * headers' grid, its intro and liability blocks printing their own wording), whose paper prints
 * through src/server/quote-canvas.ts and whose seed is src/server/quote-canvas-seed.ts, and whose
 * designer is offered and whose canvas prints through `printQuote` (PR 2 of its lane).
 * `CANVAS_PRINTS` (./index.ts) stays the gate a profiled contract must also pass before its canvas
 * prints, and the editor offers Design on a canvas only where the canvas prints (`canvasPrints`,
 * read by `panels.tsx` and `TemplateEditor.tsx`). Since PR 2 of the quotation's lane every
 * contract of the eight has a profile and is in that set, and the container tag, the ninth type (the
 * container tag design of 2026-11-13), joined it in PR 3 (`CONTAINER_TAG_CANVAS`, its `oneLabel` turning
 * on the one-label rules), so no real document reaches the later-release or the no-profile refusal.
 * Both are pinned on a docType the registry
 * does not know, the quotation's contract stubbed (tests/helpers/test-contract.ts), the later-release refusal
 * (`assertCanvasPrints`) with the stub given the certification's profile for the case alone and the
 * no-profile refusal with the stub given none (tests/template-canvas.test.ts and
 * tests/template-canvas-seed.test.ts), while tests/template-editor-shape.test.tsx holds the
 * editor's offer closed on the stub; and tests/canvas-marks-ink.test.ts holds `CANVAS_DOCS` to
 * the types whose canvas prints.
 * A null layout prints the flow paper exactly as before. A
 * canvas template prints only the items its layout holds, so the backfill-visible convention cannot
 * reach it: a field a contract gains later appears in the designer's palette as available
 * (`paletteEntries`, src/lib/canvas-designer.ts) and prints nothing on a canvas template until
 * someone places it, the design's §7 exception, while a flow
 * template backfills it shown as the list above says; a text block a contract gains later is the
 * same (the `textBlock` item). Nothing else in this header changes for a canvas: a canvas places
 * only what the contract offers (`canvasFieldKeys`, the profile's `notFields` left out), so it adds
 * no data source either. The profile is plain data (a table's printed-width rule is a kind, never a
 * function), so the MOS contract's identity pin still compares it.
 * tests/template-canvas-schema.test.ts holds the shape and its strictness,
 * tests/template-canvas.test.ts every refusal and warning on the traveler and on both tickets, and
 * on the bill of lading its profile's refusals (the field-keyed block named by its field in every
 * sentence that names a table, the toggle, the wordings, the least widths, `beside`) and warning
 * (d), not every warning, on the certification its profile's refusals and its standard's empty
 * warning set, on the invoice its profile's refusals, warning (g) and its standard's empty
 * warning set, and on the statement its profile's refusals, warnings (a), (c) on drawn boxes, (d)
 * and (e) and its standard's empty warning set, on the quote its profile's refusals, warnings
 * (a), (c) on drawn boxes, (d), (e) and (g) and its standard's empty warning set, and the
 * later-release refusal on the stubbed docType given a profile, outside `CANVAS_PRINTS`
 * (tests/template-canvas-seed.test.ts reaches it through the seed too),
 * tests/template-contracts.test.ts what a profile must hold (`profileProblems`),
 * tests/cert-templates.test.ts the certification's two floors, measured on the flow's own nodes,
 * tests/invoice-templates.test.ts the invoice's two floors, measured the same way,
 * tests/statement-canvas-floors.test.ts the statement's two floors, measured the same way, with the
 * held node's premise and the open items drawn narrow,
 * tests/quote-canvas-floors.test.ts the quotation's two floors, measured the same way, the lines
 * block's first grid row cut to its first identity line,
 * tests/invoice-canvas.test.ts the invoice's canvas paper and its widths held to the profile,
 * tests/statement-canvas.test.ts the statement's canvas paper and its widths held to the profile,
 * tests/statement-canvas-seed.test.ts its seed, the seed's refusals and its preview's measure,
 * tests/quote-canvas.test.ts the quotation's canvas paper, the profile's least widths held to the
 * flow's own widths (`QUOTE_WIDTHS`),
 * tests/quote-canvas-seed.test.ts its seed, the seed's refusals and its preview's measure,
 * tests/quote-canvas-print.test.ts its print through `printQuote`,
 * tests/bol-canvas.test.ts the bill of lading's canvas paper and `ruledFields` held to it,
 * tests/canvas-designer.test.ts the palette and the placement, and
 * tests/design-panel-shape.test.tsx the Design tab that draws them. Cite this as licence for
 * nothing: it does not make a new field on a flow template safe to backfill hidden, and a canvas on
 * another document type takes its own design, an owner ruling that names it, and a profile.
 */
import { z } from "zod";
import { canvasLayoutSchema, type CanvasLayout } from "./canvas";

// ---------------------------------------------------------------------------------------------
// Fixed vocabularies. The doc types are held to the Prisma `TemplateDocType` enum as a set by
// tests/template-doc-type-enum.test.ts: the two meet only through casts.
// ---------------------------------------------------------------------------------------------

export const TEMPLATE_DOC_TYPES = [
  "TRAVELER", "SHIPPER", "MOS_SHIPPER", "BOL", "CERT", "INVOICE", "STATEMENT", "QUOTE", "CONTAINER_TAG",
] as const;
export type TemplateDocTypeString = (typeof TEMPLATE_DOC_TYPES)[number];

/** The curated bundled set (ruling 5, plan-time confirmation) — no font upload, ever. */
export const FONT_FAMILIES = ["Roboto", "Liberation Sans", "Liberation Serif", "Roboto Mono"] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

/** The fixed date-format set (ruling 3). Every style a Phase 3–6 builder prints is here, so each
 *  DEFAULT_CONFIG can reproduce today's paper exactly: "M/D/YYYY" is the ticket header's
 *  `shortDate`, "MM/DD/YYYY" its tear-off's `paddedDate`, "MMM - DD - YYYY" the BOL's `bolDate`,
 *  and "MMMM D, YYYY" the invoice/statement `longDate`'s FULL month name ("July 29, 2026") —
 *  renamed from "MMM D, YYYY" before any config was stored (Task 2 review carry: the abbreviated
 *  token would have had Tasks 12/13 render "Jul 29" per convention and silently break golden
 *  compatibility). */
export const DATE_FORMATS = [
  "M/D/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "MMMM D, YYYY", "MMM - DD - YYYY",
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** Ruling 3's fixed negative-style picker. `SIGN_AFTER_SYMBOL` is today's "$-937.44" (the 5A
 *  ruling: the sign sits between the "$" and the digits, so magnitude and sign both read at a
 *  glance); `LEADING_MINUS` is "-$937.44"; `PARENTHESES` is "($937.44)". */
export const NEGATIVE_STYLES = ["SIGN_AFTER_SYMBOL", "LEADING_MINUS", "PARENTHESES"] as const;
export type NegativeStyle = (typeof NEGATIVE_STYLES)[number];

export const PRICE_DECIMALS = [2, 3, 4] as const;
export type PriceDecimals = (typeof PRICE_DECIMALS)[number];

export const LOGO_PLACEMENTS = ["header-left", "header-center", "header-right"] as const;
export type LogoPlacement = (typeof LOGO_PLACEMENTS)[number];

/** The label stocks a container tag prints on (owner ruling R3, the container tag design of
 *  2026-11-13 §5): one, 4 in x 3 in landscape. Each option's page is `TAG_LABEL_SIZES` (./canvas.ts).
 *  Adding a stock is one entry here and there, and a check that the Standard fits it. */
export const LABEL_SIZES = ["4x3-landscape"] as const;
export type LabelSize = (typeof LABEL_SIZES)[number];

/** An editor control a contract withholds (the container tag design of 2026-11-13 §5, calls 3 and 6):
 *  the header logo and the page line are refused by the validator (`assertWithheld`), and the small
 *  size is only hidden by the editor, the type printing nothing at it. */
export type WithheldControl = "logo" | "pageFooter" | "smallSize";

/** LETTER (612pt) minus the 24pt page margins — the width budget every column total is validated
 *  against (spec §5.6, ruling 3's guardrail). Re-declared, not imported: see the header comment. */
export const CONTENT_WIDTH = 564;

// Font sizes bounded to what fits on paper: below 4pt is unreadable ink, above 72pt is a banner,
// and both would let one knob destroy a document.
const FONT_SIZE_MIN = 4;
const FONT_SIZE_MAX = 72;

// ---------------------------------------------------------------------------------------------
// The contract — pure declarations, one module per docType.
// ---------------------------------------------------------------------------------------------

export type ColumnSpec = {
  /** Which table this field is a column of — width totals are validated per table name. */
  table: string;
  /** Today's hardcoded builder width; "*" is pdfmake's flex column and counts 0 toward totals. */
  defaultWidth: number | "*";
};

export type ContractField = {
  /** Stable key — configs reference it forever; renaming one orphans stored configs. */
  key: string;
  /** Editor display name (what the panel calls the field, not what prints). */
  name: string;
  /** The printed label; "" for value-only fields. A config's `label` override replaces it. */
  defaultLabel: string;
  /** Whether a config may hide this field. `false` + `lockReason` = a §5.6 locked element. */
  removable: boolean;
  /** The rule that locks this field, quoted verbatim in the refusal (spec §5.6). */
  lockReason?: string;
  column?: ColumnSpec;
};

export type ContractSection = {
  key: string;
  name: string;
  /** Whether a config may hide the whole section. */
  hideable: boolean;
  /** `false` pins the section to its contract index — reorders around it must preserve it. */
  reorderable: boolean;
  lockReason?: string;
  fields: ContractField[];
};

export type ContractTextBlock = {
  key: string;
  name: string;
  /** Today's standing text, copied verbatim from the builder/settings literal it replaces. */
  defaultText: string;
};

/** The format-knob SURFACE: a knob present here (with its default) is on this document's config;
 *  an absent knob is an unknown key in that config and is refused — a traveler config carrying
 *  `priceDecimals` is a bug, not a no-op. */
export type ContractFormatDefaults = {
  negativeStyle?: NegativeStyle;
  priceDecimals?: PriceDecimals;
  thousandsSeparator?: boolean;
  dateFormat?: DateFormat;
  /** The container tag's label stock (R3). Declared by that contract alone, so no stored config of
   *  another type gains the key (#103's additive test). */
  labelSize?: LabelSize;
};

export type ContractFontDefaults = {
  family: FontFamily;
  baseSize: number;
  headingSize: number;
  smallSize: number;
};

/** How a column table's header row prints over its columns (#971 design §7.2), read by warning (d):
 *  `size`, the headings' size, every heading bold: "base", the template's base size, else a size of
 *  the builder's own (the quote's column headers and the statement's aging, 9; the bill of lading's
 *  freight, 6.5). `words`: text the builder itself prints in a column's heading beside its label, by
 *  column key (the bill of lading's freight description's second line, "Special Marks, and
 *  Exceptions"); absent: none. */
export type CanvasHead = { size: "base" | number; words?: Record<string, string> };

/** How a canvas table's printed width is judged (design 2026-11-08 §4.1): a column table by its
 *  layout's padding and rules, printed `copies` times side by side; the traveler's steps table by
 *  its own measure; null for a list or a rows block, which print no columns. `beside`: the points a
 *  column table's block keeps beside its columns (the bill of lading's sidebar and its gap, 178;
 *  design 2026-11-09 §4.1 addition 2); absent: 0. `head`: how its header row prints (`CanvasHead`). */
export type CanvasTablePrinted =
  | { kind: "ruled" | "boxed" | "nested"; copies: 1 | 2; beside?: number; head: CanvasHead }
  | { kind: "steps"; head: CanvasHead } | null;
export type CanvasTableSpec = {
  key: string;
  /** What `key` names: a contract section (every table until the bill of lading), or a FIELD of a
   *  section shared with other fields, when that field alone is the block (design 2026-11-09 §4.1
   *  addition 1). Stated on every spec: a key's kind is read, never inferred. */
  keyed: "section" | "field";
  heading: string | null;   // the contract field printing the block's heading
  rows: boolean;            // a rows block: the section's fields are its rows, never given a width
  printed: CanvasTablePrinted;
  /** Fields of the block's section that are no column, listed in the item's columns as a rows block
   *  lists its rows (shown and label, never a width), printed inside the block (addition 3). */
  toggles?: string[];
  /** The contract table a section-keyed column table's columns belong to, when it is not the
   *  block's own key (the invoice's `column_header`, whose four fields name the table "columns";
   *  design 2026-11-10 §4.1 addition 1). Absent: the key. */
  columnTable?: string;
  /** The key of a section-keyed column table of the same profile (no rows block, one copy, nothing
   *  beside its columns) whose columns this rows block prints under: their order, visibility and
   *  widths, read from the layout's item of that key, else the contract's (design 2026-11-10 §4.1
   *  addition 2). */
  grid?: string;
  /** What a grid block reads of its grid's place: `left`, one column's width at its left edge (the
   *  invoice's order strip); `right`, one column's width at its right edge (the totals); absent,
   *  every column, from its left edge (across its width while a shown column is "*"; the parts,
   *  the prices). Warning (g) judges by
   *  it (open question 1 of the invoice canvas PR 1 plan). */
  gridEdge?: "left" | "right";
  /** The points a grid block prints between each two of its grid's shown columns (the invoice's
   *  part rows and prices, 6, the builder's `INVOICE_WIDTHS.gridGap`, held to it by a test). Warning
   *  (g) counts it in the least width of a block that prints every column under a grid with no "*"
   *  column. Stands only beside a `grid`; absent: 0 (invoice canvas PR 2 plan, open question 2). */
  gridGap?: number;
  /** The left margin a grid block's row builder sets inside its grid's "*" column (the invoice's
   *  part rows and prices and the quote's lines, 6: their information cell's, the builders'
   *  `INVOICE_WIDTHS.infoMargin` and `QUOTE_WIDTHS.infoIndent`, held to them by tests). pdfmake counts
   *  it in that column's least width, so the block's least width (`leastWidth`, #971) counts it while
   *  a shown grid column is "*"; a fixed column holds it inside its own width. Stands only beside a
   *  `grid`; absent: 0. */
  gridMargin?: number;
  /** A block reading its grid's left edge that prints its row indented past one of the grid's
   *  columns (the invoice's order strip: past the Quantity column and `gap`, 6, the builder's
   *  `INVOICE_WIDTHS.stripIndentGap`) and then needs `floor` points for its fields (the measured row's
   *  floor, 60, render.ts' `MEASURED_ROW_FLOOR`; both held to the builder's constants by test). With
   *  a layout handed, its least width is that column's shown width as the layout's grid holds it (a
   *  hidden one 0; no width: the contract's default), plus `gap`, plus `floor`, plus one grid step
   *  (`leastWidth`, #971), so no accepted width puts the row's start past its box. A block printing
   *  every column of its grid (no `gridEdge`) takes one too where it prints lines of its own, outside
   *  the grid's columns, indented past one of them (the invoice's PRICE heading, `gap` the builder's
   *  `INVOICE_WIDTHS.stripIndentGap`; the quote's Material line and PRICE heading, `gap` its
   *  `QUOTE_WIDTHS.infoIndent`; `floor` 0 for both): its least width is then the larger of its grid
   *  columns' and its indent's (#971, Codex review). Never beside `gridEdge` "right"; `column` is a
   *  column of the grid. */
  gridIndent?: { column: string; gap: number; floor: number };
  /** A block reading its grid's right edge that prints one of the grid's columns there beside fixed
   *  parts of its own (the invoice's totals: the Amount column, beside the 200 pt label and the two
   *  6 pt gaps either side of it, `fixed` 212, the builder's `INVOICE_WIDTHS.totalsLabel` and
   *  `totalsGap`, held to them by test). With a layout handed, its least width is that column's width
   *  as the builder reads it (a shown column's typed width; untyped or hidden, the contract's default,
   *  as the builder's `slotW.amt || W.amt` falls back), plus `fixed`, plus one grid step (`leastWidth`,
   *  #971), so an Amount typed wider raises it. Stands only beside `gridEdge` "right"; `column` is a
   *  column of the grid. */
  gridEdgeColumn?: { column: string; fixed: number };
  /** The block prints at least as tall as its drawn box, and taller when its content needs more
   *  (the statement's Bill To, beside the Remit To box; design 2026-11-11 §4.1). Stands only on a
   *  block keyed by a field. Read at print by the statement's own `tableBlock`
   *  (src/server/statement-canvas.ts), never by `assembleCanvasSheet`; at the seed by
   *  `seedStatementItems` (src/server/statement-canvas-seed.ts), which draws the block down to the
   *  Remit To box's bottom where it ends the left column and adds nothing to the blocks' lift; and
   *  beside them by `profileProblems`. Absent: the block prints at its content. */
  holdsHeight?: true;
  /** Text blocks the block prints itself; no text-block item may place them (addition 4). */
  textBlocks?: string[];
};
/** An element a layout must hold: the barcode, a table by key, or a field by key (the container tag's
 *  Order number, owner ruling R6). A field is judged by rule 2 alone; rule 6 never covers it (design
 *  call 19: a box may be drawn around it). */
export type CanvasRequired =
  | { kind: "barcode"; reason: string }
  | { kind: "table"; key: string; reason: string }
  | { kind: "field"; key: string; reason: string };
/** A field the stage draws on a rule, as the paper prints it (design 2026-11-09 §4.1; owner ruling
 *  (a), 2026-11-10): "beside", its label beside a rule under the rest of the box; "lines", its label
 *  beside two rules `column` points long. ("under", a rule with the label under it, was the carrier's
 *  until owner ruling R1 of 2026-11-24 printed every label beside its rule.) */
export type CanvasRuledField = { key: string; draw: "beside" | "lines"; column?: number };
/** What the shared canvas code reads from a document (design 2026-11-08 §4.1): the tables a layout
 *  may place, the items it must hold and nothing may cover, whether it may place a barcode, the
 *  fields it never places as a field item, the fields that print in a border, the fields the stage
 *  draws on a rule, a table box's least
 *  height (one row) and the room the first table needs above the band (a heading and one row).
 *  Plain data: no function. */
export type CanvasProfile = {
  /** The word a sentence calls one printed document: "traveler", "shipping ticket". */
  paper: string;
  tables: CanvasTableSpec[];
  required: CanvasRequired[];
  barcode: boolean;
  notFields: string[];
  /** The field keys whose item draws the border the paper draws (a party box); every other field
   *  prints bare. */
  boxedFields: string[];
  /** The fields whose item the stage draws on a rule, each with its drawing (the bill of lading's
   *  form and write-in rules, its carrier line and its consignee; design 2026-11-09 §4.1). `[]` when
   *  none is: every other field draws bare. The live page is the truth either way. */
  ruledFields: CanvasRuledField[];
  /** The least width of an item whose family has fixed parts, by item key (a field's or a block's),
   *  in points: its fixed columns and gaps plus one grid step (design 2026-11-09 §4.1 addition 5).
   *  A grid block printing every column of its grid (a `grid` and no `gridEdge`) reads its grid's
   *  columns from the layout instead, and its entry here is the figure at the contract's columns,
   *  read where no layout is handed (#971 design §6.1). A column table's least width is its printed
   *  columns' (`leastWidth`), never an entry here. `{}` when none has. */
  leastWidths: Record<string, number>;
  rowFloor: number;
  firstTableRoom: number;
  /** The paper is one label (the container tag, the container tag design of 2026-11-13 §7.2): every
   *  item is placed page-top and none repeats (call 10), a text item's box is at least one line of
   *  its text (R12), and `wholeField`'s item, its label joined to `digits` of the face's widest
   *  digit, fits the label's content width at its own size and face (R10, call 18). Absent: none of
   *  these rules runs (every Letter document). */
  oneLabel?: { wholeField: { key: string; digits: number } };
};

export type TemplateContract = {
  docType: TemplateDocTypeString;
  name: string;
  sections: ContractSection[];
  textBlocks: ContractTextBlock[];
  /** The block the editor's clause list opens on, when it is not the first (owner 2026-11-02 on
   *  #828). The editor's alone: no builder, validator or default reads it. */
  openTextBlock?: string;
  formats: ContractFormatDefaults;
  fonts: ContractFontDefaults;
  /** Per-table width budgets where a table does NOT get the full content width — a table printed
   *  twice side-by-side (the ticket's container fold) or beside a fixed sidebar (the BOL's
   *  freight block) declares the width its columns actually have. Absent = CONTENT_WIDTH. */
  tableBudgets?: Record<string, number>;
  /** The config's `pageFooter` default. Absent = false — no Phase 3–6 paper prints one EXCEPT
   *  the quote, whose builder already prints "Page: N of M" via its footer callback: golden
   *  compatibility means the quote's default reproduces THAT, so its contract alone sets true. */
  pageFooter?: boolean;
  /** The canvas profile (design 2026-11-08 §4.1). Absent: the document offers no canvas. */
  canvas?: CanvasProfile;
  /** The editor controls this document withholds (the container tag design of 2026-11-13 §5): a
   *  withheld `logo` refuses a non-null `logo`, a withheld `pageFooter` refuses `pageFooter: true`
   *  (`assertWithheld`), and a withheld `smallSize` is the editor's to hide. Absent: none. */
  withholds?: readonly WithheldControl[];
  /** The editor offers a "Print no label" checkbox beside each field's label box (the container tag,
   *  owner ruling 2026-11-13): checked stores `label: ""`, which prints the value alone. Absent: no
   *  checkbox, and an empty box means the default, as on every other type. */
  blankLabels?: true;
};

// ---------------------------------------------------------------------------------------------
// The config — the per-version JSON (spec §5.3). Logo BYTES live on the version row, never here;
// the config carries only placement + width.
// ---------------------------------------------------------------------------------------------

export type FieldConfig = {
  key: string;
  visible: boolean;
  /** Label override; null = the contract's `defaultLabel`. */
  label: string | null;
  /** Column-width override; null = the contract's `defaultWidth`. Only column fields accept one. */
  width: number | null;
};

export type SectionConfig = {
  key: string;
  visible: boolean;
  /** Array order IS display order — for sections and for fields alike. */
  fields: FieldConfig[];
};

export type FormatsConfig = {
  negativeStyle?: NegativeStyle;
  priceDecimals?: PriceDecimals;
  thousandsSeparator?: boolean;
  dateFormat?: DateFormat;
  labelSize?: LabelSize;
};

export type FontsConfig = {
  family: FontFamily;
  baseSize: number;
  headingSize: number;
  smallSize: number;
};

export type LogoConfig = { placement: LogoPlacement; width: number };

export type TemplateConfig = {
  sections: SectionConfig[];
  formats: FormatsConfig;
  fonts: FontsConfig;
  textBlocks: Record<string, string>;
  logo: LogoConfig | null;
  /** "Page N of M" (spec §6.1). Defaults to the contract's `pageFooter` (false everywhere but
   *  the quote, whose builder prints one today) — the backfill must keep old versions rendering
   *  identically. */
  pageFooter: boolean;
  /** The canvas layout. null is the flow layout, every stored config's (the design of 2026-11-07). */
  layout: CanvasLayout | null;
};

/** A contract-rule refusal — hiding a locked element, a blown width budget, a duplicate entry.
 *  Services translate this into their own `HttpError`; this module stays server-free. A canvas
 *  refusal (`validateCanvasLayout`) also carries the ids of the layout items its sentence names, so
 *  the designer can outline them (PR C of #926); every other refusal names none, and every catcher
 *  that reads only `.message` is unchanged. */
export class TemplateConfigError extends Error {
  readonly itemIds: string[];
  constructor(message: string, itemIds: string[] = []) {
    super(message);
    this.name = "TemplateConfigError";
    this.itemIds = itemIds;
  }
}

// ---------------------------------------------------------------------------------------------
// Defaults — the canonical "today's paper" config, derived from the contract so the backfill and
// DEFAULT_CONFIG can never disagree.
// ---------------------------------------------------------------------------------------------

export function defaultFieldConfig(field: ContractField): FieldConfig {
  return { key: field.key, visible: true, label: null, width: null };
}

export function defaultSectionConfig(section: ContractSection): SectionConfig {
  return { key: section.key, visible: true, fields: section.fields.map(defaultFieldConfig) };
}

function defaultTextBlocks(contract: TemplateContract): Record<string, string> {
  return Object.fromEntries(contract.textBlocks.map((t) => [t.key, t.defaultText]));
}

export function defaultConfig(contract: TemplateContract): TemplateConfig {
  return {
    sections: contract.sections.map(defaultSectionConfig),
    formats: { ...contract.formats },
    fonts: { ...contract.fonts },
    textBlocks: defaultTextBlocks(contract),
    logo: null,
    pageFooter: contract.pageFooter ?? false,
    layout: null,
  };
}

/**
 * The §5.6 belt's OMISSION half (Phase 7 Task 8, carried from the Task 7 review) — the merge
 * every BUILDER resolves its section views over instead of using `config.sections` raw.
 *
 * The flag-based builder belt (each builder's `sectionView`) forces visibility on locked entries,
 * but it can only force entries that are PRESENT: a validator-bypassing config that simply omits
 * the steps section entry (or a locked field entry) would drop the locked element without ever
 * tripping a flag. This helper merges the config's section/field lists with the contract's key
 * list — a leading-run merge: the config's entries lead, untouched and in config order; every
 * contract section or field missing from the config appends after them in contract order with
 * the contract's defaults (`defaultSectionConfig`/`defaultFieldConfig`), so omission cannot drop
 * anything.
 *
 * Unreachable through stored configs — `validateContractConfig`'s §5.3 backfill re-inserts
 * missing entries at their contract POSITION — but the belt's own rationale (spec §5.6: the
 * editor and validator alone are not the enforcement) applies to the builder too. Deliberately
 * APPEND, not the backfill's position splice: the belt's one job is presence — it must never
 * reorder what a config actually says, and where an omitted element lands on a config that could
 * never have been stored is unspecified. Unknown keys pass through untouched: they stay the
 * validator's refusal, and each builder's own view resolution throws on them.
 *
 * Client-safe like everything in this module; Tasks 9–14's builders adopt this same helper.
 */
export function completeSections(
  contract: TemplateContract, sections: SectionConfig[],
): SectionConfig[] {
  const merged = [...sections];
  for (const cs of contract.sections) {
    if (!merged.some((s) => s.key === cs.key)) merged.push(defaultSectionConfig(cs));
  }
  const contractByKey = new Map(contract.sections.map((cs) => [cs.key, cs]));
  return merged.map((s) => {
    const cs = contractByKey.get(s.key);
    if (cs === undefined) return s; // unknown key — the validator's refusal, not the belt's
    const fields = [...s.fields];
    for (const cf of cs.fields) {
      if (!fields.some((f) => f.key === cf.key)) fields.push(defaultFieldConfig(cf));
    }
    return { ...s, fields };
  });
}

/** The namespace a locked element lives in — a section key and a field key can collide (each is
 *  only unique within its own kind), so the editor must key its padlock lookups by (scope, key),
 *  never key alone (Task 1 review carry). */
export type LockScope = "section" | "field";
export type LockedElement = { scope: LockScope; key: string; reason: string };

/** Every §5.6-locked element with its reason, NAMESPACED by scope — what the editor renders the
 *  padlock from. Sections come before their fields, contract order preserved. */
export function lockedElements(contract: TemplateContract): LockedElement[] {
  const out: LockedElement[] = [];
  for (const section of contract.sections) {
    if (section.lockReason !== undefined) {
      out.push({ scope: "section", key: section.key, reason: section.lockReason });
    }
    for (const field of section.fields) {
      if (field.lockReason !== undefined) {
        out.push({ scope: "field", key: field.key, reason: field.lockReason });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The generated zod schema — `.strict()` at every level, per-key defaults from the contract.
// ---------------------------------------------------------------------------------------------

function fieldSchema(field: ContractField) {
  return z.object({
    key: z.literal(field.key),
    visible: z.boolean().default(true),
    label: z.string().nullable().default(null),
    // Only a column field can carry a width override; on anything else the sole legal value is
    // null, so a stray number is refused by shape, not by a rule someone could forget.
    width: field.column
      ? z.number().positive().max(CONTENT_WIDTH).nullable().default(null)
      : z.null().default(null),
  }).strict();
}

/**
 * Section/field entries are dispatched by `key` to their own strict per-entry schema inside a
 * transform, rather than through `z.discriminatedUnion`: the option lists here are built at
 * runtime from contract data (a tuple-typed union fights that), and the dispatch gives exact
 * messages — the unknown KEY is named, and a matched entry's issues carry its array index.
 */
function dispatchEntries<T>(
  entries: unknown[], ctx: z.core.$RefinementCtx, kind: "section" | "field",
  schemaByKey: Map<string, z.ZodType>,
): T[] {
  const out: T[] = [];
  for (const [index, raw] of entries.entries()) {
    if (typeof raw !== "object" || raw === null || typeof (raw as { key?: unknown }).key !== "string") {
      ctx.addIssue({ code: "custom", message: `Each ${kind} entry must be an object with a string "key"`, path: [index] });
      continue;
    }
    const key = (raw as { key: string }).key;
    const schema = schemaByKey.get(key);
    if (schema === undefined) {
      ctx.addIssue({ code: "custom", message: `Unknown ${kind} key "${key}"`, path: [index] });
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message, path: [index, ...issue.path] });
      }
      continue;
    }
    out.push(parsed.data as T);
  }
  return out;
}

function sectionSchema(section: ContractSection) {
  const byKey = new Map<string, z.ZodType>(section.fields.map((f) => [f.key, fieldSchema(f)]));
  return z.object({
    key: z.literal(section.key),
    visible: z.boolean().default(true),
    fields: z.array(z.unknown())
      .transform((entries, ctx) => dispatchEntries<FieldConfig>(entries, ctx, "field", byKey))
      .default(() => section.fields.map(defaultFieldConfig)),
  }).strict();
}

/** The editor-facing schema for one contract: shape, strictness, enums, and scalar defaults.
 *  `validateContractConfig` below adds the contract rules and the entry-level backfill. */
export function configSchema(contract: TemplateContract): z.ZodType<TemplateConfig> {
  const sectionByKey = new Map<string, z.ZodType>(
    contract.sections.map((s) => [s.key, sectionSchema(s)]));

  // Only DECLARED knobs exist on the formats object — .strict() makes an undeclared knob an
  // unknown key. Each declared knob defaults to the contract's value (the §5.3 backfill).
  const formatEntries: Record<string, z.ZodType> = {};
  if (contract.formats.negativeStyle !== undefined) {
    formatEntries.negativeStyle = z.enum(NEGATIVE_STYLES).default(contract.formats.negativeStyle);
  }
  if (contract.formats.priceDecimals !== undefined) {
    formatEntries.priceDecimals = z.literal([...PRICE_DECIMALS]).default(contract.formats.priceDecimals);
  }
  if (contract.formats.thousandsSeparator !== undefined) {
    formatEntries.thousandsSeparator = z.boolean().default(contract.formats.thousandsSeparator);
  }
  if (contract.formats.dateFormat !== undefined) {
    formatEntries.dateFormat = z.enum(DATE_FORMATS).default(contract.formats.dateFormat);
  }
  if (contract.formats.labelSize !== undefined) {
    formatEntries.labelSize = z.enum(LABEL_SIZES).default(contract.formats.labelSize);
  }

  const fontSize = z.number().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX);

  const schema = z.object({
    sections: z.array(z.unknown())
      .transform((entries, ctx) => dispatchEntries<SectionConfig>(entries, ctx, "section", sectionByKey))
      .default(() => contract.sections.map(defaultSectionConfig)),
    formats: z.object(formatEntries).strict().default(() => ({ ...contract.formats })),
    fonts: z.object({
      family: z.enum(FONT_FAMILIES).default(contract.fonts.family),
      baseSize: fontSize.default(contract.fonts.baseSize),
      headingSize: fontSize.default(contract.fonts.headingSize),
      smallSize: fontSize.default(contract.fonts.smallSize),
    }).strict().default(() => ({ ...contract.fonts })),
    textBlocks: z.object(
      Object.fromEntries(contract.textBlocks.map((t) => [t.key, z.string().default(t.defaultText)])),
    ).strict().default(() => defaultTextBlocks(contract)),
    logo: z.object({
      placement: z.enum(LOGO_PLACEMENTS),
      width: z.number().positive().max(CONTENT_WIDTH),
    }).strict().nullable().default(null),
    pageFooter: z.boolean().default(contract.pageFooter ?? false),
    layout: canvasLayoutSchema.nullable().default(null),
  }).strict();

  // The runtime shape is exactly TemplateConfig; zod's inferred type is wider (dynamic object
  // shapes infer as records, literal keys as strings), so the narrowing lives here, once.
  return schema as unknown as z.ZodType<TemplateConfig>;
}

// ---------------------------------------------------------------------------------------------
// validateContractConfig — parse, backfill, contract rules. Always returns a COMPLETE config.
// ---------------------------------------------------------------------------------------------

function refuseDuplicates(kind: "section" | "field", keys: string[]): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new TemplateConfigError(`Duplicate ${kind} "${key}"`);
    seen.add(key);
  }
}

/** Missing entries are the §5.3 evolution case (the stored config predates the element), so each
 *  is re-inserted at its contract position with the contract's defaults. */
function backfillSections(contract: TemplateContract, sections: SectionConfig[]): SectionConfig[] {
  const merged = [...sections];
  contract.sections.forEach((cs, index) => {
    if (!merged.some((s) => s.key === cs.key)) {
      merged.splice(Math.min(index, merged.length), 0, defaultSectionConfig(cs));
    }
  });
  const byKey = new Map(contract.sections.map((cs) => [cs.key, cs]));
  return merged.map((s) => {
    const cs = byKey.get(s.key);
    if (cs === undefined) throw new TemplateConfigError(`Unknown section key "${s.key}"`); // unreachable after parse
    refuseDuplicates("field", s.fields.map((f) => f.key));
    const fields = [...s.fields];
    cs.fields.forEach((cf, index) => {
      if (!fields.some((f) => f.key === cf.key)) {
        fields.splice(Math.min(index, fields.length), 0, defaultFieldConfig(cf));
      }
    });
    return { ...s, fields };
  });
}

function lockMessage(name: string, verb: string, reason: string | undefined): string {
  return `"${name}" cannot be ${verb}${reason === undefined ? "" : `: ${reason}`}`;
}

function assertLocksHonored(contract: TemplateContract, sections: SectionConfig[]): void {
  const sectionByKey = new Map(contract.sections.map((cs) => [cs.key, cs]));
  for (const s of sections) {
    const cs = sectionByKey.get(s.key);
    if (cs === undefined) continue; // unknown keys already refused
    if (!s.visible && !cs.hideable) {
      throw new TemplateConfigError(lockMessage(cs.name, "hidden", cs.lockReason));
    }
    // Hiding a section hides every field in it (the Task 1 review carry): a *hideable* section
    // sheltering a non-removable field is refused with the FIELD's lock reason — otherwise the
    // section knob is a lock bypass, and only contract discipline (pinning such sections
    // non-hideable) would stand between a config and a quietly-omitted locked element.
    if (!s.visible) {
      const lockedField = cs.fields.find((cf) => !cf.removable);
      if (lockedField !== undefined) {
        throw new TemplateConfigError(
          `Hiding "${cs.name}" would hide "${lockedField.name}", which cannot be hidden` +
          (lockedField.lockReason === undefined ? "" : `: ${lockedField.lockReason}`));
      }
    }
    const fieldByKey = new Map(cs.fields.map((cf) => [cf.key, cf]));
    for (const f of s.fields) {
      const cf = fieldByKey.get(f.key);
      if (cf === undefined) continue;
      if (!f.visible && !cf.removable) {
        throw new TemplateConfigError(lockMessage(cf.name, "hidden", cf.lockReason));
      }
    }
  }
  // A pinned (non-reorderable) section must sit at its contract index — reorders around it are
  // fine as long as they leave it where the contract put it.
  contract.sections.forEach((cs, contractIndex) => {
    if (cs.reorderable) return;
    const index = sections.findIndex((s) => s.key === cs.key);
    if (index !== contractIndex) {
      throw new TemplateConfigError(lockMessage(cs.name, "reordered", cs.lockReason));
    }
  });
}

/** Width totals per table, over VISIBLE columns of VISIBLE sections only — hiding a column is
 *  exactly how a template frees budget to widen another, so dormant widths must not count. */
function assertWidthBudgets(contract: TemplateContract, sections: SectionConfig[]): void {
  const sectionByKey = new Map(contract.sections.map((cs) => [cs.key, cs]));
  const totals = new Map<string, number>();
  for (const s of sections) {
    if (!s.visible) continue;
    const cs = sectionByKey.get(s.key);
    if (cs === undefined) continue;
    const fieldByKey = new Map(cs.fields.map((cf) => [cf.key, cf]));
    for (const f of s.fields) {
      const cf = fieldByKey.get(f.key);
      if (cf?.column === undefined || !f.visible) continue;
      const width = f.width ?? cf.column.defaultWidth;
      if (width === "*") continue;
      totals.set(cf.column.table, (totals.get(cf.column.table) ?? 0) + width);
    }
  }
  for (const [table, total] of totals) {
    const budget = contract.tableBudgets?.[table] ?? CONTENT_WIDTH;
    if (total > budget) {
      throw new TemplateConfigError(
        `The "${table}" table's visible column widths total ${total}pt, past its ${budget}pt budget` +
        ` (LETTER content width is ${CONTENT_WIDTH}pt)`);
    }
  }
}

/** Refuses a config that sets a control its contract withholds (`TemplateContract.withholds`): a
 *  header logo, `The ${name} template prints no header logo.`; a page line, `The ${name} template
 *  prints no page line.` A withheld small size refuses nothing: every size is legal, and the type
 *  prints nothing at it. The registry runs it on the container tag (`withTagRules`, ./index.ts). */
export function assertWithheld(contract: TemplateContract, config: TemplateConfig): void {
  const withholds = contract.withholds ?? [];
  if (withholds.includes("logo") && config.logo !== null) {
    throw new TemplateConfigError(`The ${contract.name} template prints no header logo.`);
  }
  if (withholds.includes("pageFooter") && config.pageFooter) {
    throw new TemplateConfigError(`The ${contract.name} template prints no page line.`);
  }
}

/**
 * Parses a stored (or incoming) config against one contract, applying the §5.3 backfill and
 * enforcing the contract rules. Throws `ZodError` for shape problems, `TemplateConfigError` for
 * rule violations; returns a complete `TemplateConfig` otherwise. The registry-facing
 * `validateConfig(docType, json)` lives in ./index.ts — the registry imports the contract
 * modules, which import this file, so the docType lookup cannot live here without a cycle.
 * This battery runs at print time against immutable PUBLISHED configs — before tightening any
 * rule it enforces, read the evolution warning in this file's header (#103).
 */
export function validateContractConfig(contract: TemplateContract, json: unknown): TemplateConfig {
  const parsed = configSchema(contract).parse(json);
  refuseDuplicates("section", parsed.sections.map((s) => s.key));
  const sections = backfillSections(contract, parsed.sections);
  assertLocksHonored(contract, sections);
  assertWidthBudgets(contract, sections);
  return { ...parsed, sections };
}
