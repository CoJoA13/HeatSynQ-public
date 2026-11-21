#!/usr/bin/env node
// Playwright E2E harness (spec §12 / HANDOFF §5a). Drives the bundled Chromium against a
// throwaway web server on port 3100, running the owner-reviewable flows in sequence. By default
// (#326) that server is a freshly built standalone `node server.js`; `E2E_SERVER=dev` runs
// `next dev` instead. Each flow gets its own browser context (so it gets its own video.webm) and
// its own numbered screenshot sequence under e2e-artifacts/<flow>/.
//
// `npm run test:e2e` runs the manual-capture regressions, then this harness. `HEADED=1` runs
// headed. Exits non-zero if any flow fails; dev-DB fixtures are always cleaned up — normal
// completion, a flow throwing, or a Ctrl-C mid-run (SIGINT/SIGTERM handlers below run the same
// teardown) — and a self-heal in db-fixtures.ts's create() means even a run that skipped its own
// teardown (killed harder than a SIGTERM, or a bug) doesn't wedge the next one.
import { selectProcessFlows } from "./lib/process-flow-selection.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeApiMutate } from "./api-mutate.mjs";
import { login } from "./lib/auth.mjs";
import { UPDATES_DIR_NAME } from "./lib/updates-folder.mjs";
import { HOST_RESOLVER_RULE, browserEnv } from "./lib/insecure-origin.mjs";
import { devServerArgs, resolveDevBundler, resolveServerMode, serverEnv, STANDALONE_COPIES } from "./lib/server-mode.mjs";
import {
  attemptDir,
  classifyFailure,
  findRawApiMutations,
  IGNORED_REQUEST_FAILURE,
  MUTATING_METHODS,
  NETWORK_CHANGED_HINT,
  isSessionEndpoint,
  resultsLine,
  retryRefusal,
} from "./lib/failure-classify.mjs";
import { findAmbientRowLocators, findBareReads, findPlainErrorFailures, findRawRouteCalls, findUncheckedAbsenceAssertions } from "./lib/flow-lint.mjs";
import { preflightRefusal } from "./lib/preflight.mjs";
// With its `.ts` ending, as e2e/lib/printed-page.mjs imports tests/helpers/pdf.ts: plain node
// resolves a relative name no other way, and the leaf imports nothing (its header).
import { CUSTOMER_FOLDERS_MARKER } from "../src/lib/invoice-folder-entry.ts";
import { suiteSources } from "./lib/suite-sources.mjs";
import { warmRoutes, warmupRefusal } from "./lib/warmup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ERP_ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(ERP_ROOT, "src", "app");
const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;
const ARTIFACTS_DIR = path.join(ERP_ROOT, "e2e-artifacts");
const BROWSER_CHANNEL = process.env.E2E_BROWSER_CHANNEL;
if (BROWSER_CHANNEL && BROWSER_CHANNEL !== "chromium") {
  throw new Error(`E2E_BROWSER_CHANNEL must be chromium when set, received ${JSON.stringify(BROWSER_CHANNEL)}`);
}
// #184 fix (b), fix round: the previous run's artifacts, kept rather than deleted. main() used to
// `rm -rf` ARTIFACTS_DIR on every start, which destroyed dev-server.log and the failing
// screenshots the moment anyone did the thing #184 documents people doing — re-running to see if
// it clears. One generation, renamed rather than accumulated, so it can never grow without bound.
const PREV_ARTIFACTS_DIR = path.join(ERP_ROOT, "e2e-artifacts-prev");
// #184 fix (b): the dev server's stdout+stderr, written on EVERY run rather than only when
// startup times out. Both implementers who hit #184 had to reason from a failure screenshot,
// with no way to see whether the server had logged a slow compile, a stack, or an OOM. Streamed
// live rather than dumped at the end so a run killed harder than SIGTERM still leaves it behind.
const DEV_SERVER_LOG = path.join(ARTIFACTS_DIR, "dev-server.log");
// Phase 8C: the backups flow writes REAL pg_dump archives, so the harness owns a throwaway folder
// rather than inheriting the developer's BACKUP_DIR (or, worse, writing into erp/backups and
// leaving archives behind). Created fresh in main(), removed in teardown().
const BACKUP_DIR = path.join(ERP_ROOT, "e2e-backups");
// #588: invoice-shipped-order files a finalized print in a customer's folder on the office share,
// so the harness owns a throwaway share, the BACKUP_DIR precedent above, rather than inheriting a
// developer's OFFICE_SHARE_DIR: created fresh with its marker file in main(), removed in
// teardown(), and handed to the server in both server modes. The root is the share as the office's
// PCs would show it, a mapped drive (plan Amendment 9). The flow reads both from `ctx.officeShare`
// and never retypes them.
const OFFICE_SHARE_DIR = path.join(ERP_ROOT, "e2e-customer-folders");
const OFFICE_SHARE_ROOT = "Z:\\";
// Release updates (PR 3): the folder the server reads update status from and writes its hold into.
// Handed to the server in both modes as UPDATES_DIR (over a developer's own value), and to the
// release-updates flow as `ctx.updatesDir`. The flow creates it, empties it and removes it itself,
// and db-fixtures.ts reaps what an interrupted run left, so setup and teardown here add no step;
// until the flow writes a status file the server finds no update information and every other flow
// is unchanged.
const UPDATES_DIR = path.join(ERP_ROOT, UPDATES_DIR_NAME);
const HEADED = Boolean(process.env.HEADED);
// #326: the required check runs the production build; E2E_SERVER=dev keeps the next dev path
// (the nightly run and `npm run test:e2e:dev`). An unknown value refuses at import.
const SERVER_MODE = resolveServerMode(process.env.E2E_SERVER);
// #209: E2E_DEV_WEBPACK=1 moves the dev server to webpack. The nightly set it until the owner's
// ruling of 2026-10-08; it is now a local escape hatch. A typo, or the knob on a production-mode
// run, refuses at import like E2E_SERVER.
const DEV_BUNDLER = resolveDevBundler(process.env.E2E_DEV_WEBPACK, SERVER_MODE);

// Order matters for two reasons: later flows build on state earlier ones leave behind (the
// fixture part's two steps, which db-fixtures.ts's create writes, are what typed-fields,
// revision-cut and blocked-code-delete go on to use, each after the one before), and some flows
// run as the restricted user rather than admin.
//
// Task 17 (Phase 3) adds the last four, all as admin (the restricted fixture user holds only
// parts.view/processes.view — none of orders.*/void_order): order-entry-full creates the one
// order the other three all operate on (its id/number travel via `ctx.created`, set at the end of
// that flow), board-search-scan and loads-after-print both need it live, and void-order runs last
// because voiding it leaves nothing for a later flow to build on.
// Task 20 (Phase 4) adds the last five, per design spec §13. Unlike the four Phase 3 order flows
// (which share one order), each Phase 4 flow creates its own order(s) through the real entry page
// against its own fixture customer, so they carry no cross-flow state — only the run order
// matters for the numbering the demo doc narrates. `credit-hold-block-and-override` starts as the
// fixture "clerk" (shipping permissions but NOT action.override_credit_hold — the blocked half)
// and re-logs-in as the fixture admin mid-flow for the override half.
// Task 20 (Phase 5A) adds the 16th flow, `invoice-shipped-order`, as admin — it creates its own
// order/customer and leaves nothing later flows depend on, so it ran last (of 16) for the same
// reason void-order and credit-hold-block-and-override do (nothing after it needs its state).
// Task 17 (Phase 5B) adds the 17th flow, `receivables-apply-age-statement`, as
// admin (needs `write_off`, which the admin fixture role holds via ALL_PERMISSIONS) — it seeds
// its own shipped-and-invoiced order against its own fixture customer (the `invoice-shipped-
// order.mjs` precedent) and then drives the new `/receivables` screens (batch, apply, aging,
// statement print+archive) end to end.
// Task 9 (Phase 5C) adds the 18th flow, `close-month-end`, as admin (needs
// `close_ar_period`/`run_qbo_export`, both held via ALL_PERMISSIONS) — it sets the four Admin ->
// Billing GL defaults, seeds its own shipped-and-invoiced order + a partly-applied/written-off
// payment against its own fixture customer (no discount since #69 — a 600.00 check cannot settle a
// 1,000.00 invoice, and the flow asserts the offer's absence; the discount's happy path lives in
// `receivables-apply-age-statement`'s settling second check), closes the current month, exports the
// GL delta, then
// reopens/corrects/re-closes/re-exports and confirms the reversing delta. Ran last (of 18) for the
// same "nothing after it needs its state" reason as every other flow at the tail of this list — and
// deliberately AFTER `receivables-apply-age-statement`, whose own invoice stays FINALIZED (never
// unlocked) for the rest of the run and so lands inside the SAME calendar month's close scope; the
// close flow's own fixtures backfill that invoice's step code/payment type with GL accounts for
// exactly this reason (`e2e/lib/db-fixtures.ts`'s `arOpGlAccountName`/`closePaymentType` comments).
// Task 11 (Phase 6) adds the 19th and now-last flow, `quotes`, as admin — the full quoting
// lifecycle (ending statement default → quote with linked + free-text lines and a price break →
// print → order-entry auto-link → ship → draft invoice naming "Quote #N" → close-with-reason
// warning → follow-up/expired worklist) against its own fixture customer/part. It runs last for
// the usual nothing-after-needs-its-state reason, and running AFTER `close-month-end` (which
// leaves the current month CLOSED until teardown) is safe by construction: the flow's invoice is
// created and STAYS a DRAFT — `createInvoice` is not a posting mutation, so `assertPeriodOpen`
// never guards it — and a draft has no `finalizedAt`, so it can never enter the close flow's
// readiness/export scope either (which is also why the quote fixtures carry no GL accounts).
const FLOWS = [
  { name: "typed-fields", as: "admin", module: "./flows/typed-fields.mjs" },
  { name: "revision-cut", as: "admin", module: "./flows/revision-cut.mjs" },
  { name: "blocked-code-delete", as: "admin", module: "./flows/blocked-code-delete.mjs" },
  { name: "admin-selector-keyboard", as: "admin", module: "./flows/admin-selector-keyboard.mjs" },
  { name: "permission-gating", as: "restricted", module: "./flows/permission-gating.mjs" },
  // #517: a part's Pricing refuses decimal boxes by name before it sends. It prices the fixture
  // part's one operation and puts its unit price back, so it runs as admin right after the gating
  // flow that reads that same card.
  { name: "pricing-decimal-entry", as: "admin", module: "./flows/pricing-decimal-entry.mjs" },
  { name: "order-entry-full", as: "admin", module: "./flows/order-entry-full.mjs" },
  // #517: New order refuses decimal boxes by name, lists every refusal and jumps to the first.
  // It keys its own part and order against the order fixture customer.
  { name: "order-entry-decimal-entry", as: "admin", module: "./flows/order-entry-decimal-entry.mjs" },
  // #494, #546: a server refusal of a container's, a part line's, a serial's or a charge's value
  // lands on the box the server names. It answers most of its own Saves with the server's refusal
  // and lets one reach the server, which refuses it, so no order is saved; its parts are keyed like
  // the flow above's.
  { name: "order-entry-server-refusal", as: "admin", module: "./flows/order-entry-server-refusal.mjs" },
  { name: "order-entry-workspace", as: "admin", module: "./flows/order-entry-workspace.mjs" },
  { name: "order-entry-workspace-races", as: "admin", module: "./flows/order-entry-workspace-races.mjs" },
  { name: "order-entry-workspace-recovery", as: "admin", module: "./flows/order-entry-workspace-recovery.mjs" },
  { name: "order-entry-workspace-print", as: "admin", module: "./flows/order-entry-workspace-print.mjs" },
  { name: "attachment-filenames", as: "admin", module: "./flows/attachment-filenames.mjs" },
  { name: "board-search-scan", as: "admin", module: "./flows/board-search-scan.mjs" },
  // R20 (#683): a saved view is marked "(changed)" and Update view writes the arrangement back.
  // Writes one saved view for the admin user, reaped with it; nothing a later flow reads.
  { name: "saved-views", as: "admin", module: "./flows/saved-views.mjs" },
  { name: "global-search", as: "admin", module: "./flows/global-search.mjs" },
  // #332: ends its own session (counted logout) and re-signs in; touches no shared state.
  { name: "session-expiry", as: "admin", module: "./flows/session-expiry.mjs" },
  { name: "loads-after-print", as: "admin", module: "./flows/loads-after-print.mjs" },
  { name: "void-order", as: "admin", module: "./flows/void-order.mjs" },
  { name: "ship-partial-then-complete", as: "admin", module: "./flows/ship-partial-then-complete.mjs" },
  { name: "multi-order-shipment", as: "admin", module: "./flows/multi-order-shipment.mjs" },
  // #309, weights §12, #487 and, last, #573: on the saved shipment page an Add order answered beside
  // a refused Route save is read again, in both orderings. As admin, it keys two orders and a
  // shipment for the shipping fixture customer and leaves both orders on the shipment, which no
  // later flow reads.
  { name: "discard-grid-edits", as: "admin", module: "./flows/discard-grid-edits.mjs" },
  // #484: the saved shipment page shows its own ship-to address with the address list read, with
  // that read failing, and without customers.view, where clearing it is one-way. As admin, it keys
  // its own order and shipment for the shipping fixture customer, narrows the restricted role for
  // one part and restores it, and leaves a fully shipped order and a shipment with no ship-to,
  // which no later flow reads.
  { name: "shipment-ship-to", as: "admin", module: "./flows/shipment-ship-to.mjs" },
  // #517: a saved order's Containers grid and Lines boxes refuse decimal boxes by name before they
  // send. It keys its own part and order against the order fixture customer.
  { name: "order-hub-decimal-entry", as: "admin", module: "./flows/order-hub-decimal-entry.mjs" },
  // #743: the order hub's Print tags downloads one 4 in × 3 in tag per saved container row, closes
  // over unsaved work and stores nothing. It keys its own parts and order against the order fixture
  // customer, and leaves nothing later flows read.
  { name: "container-tags", as: "admin", module: "./flows/container-tags.mjs" },
  // #517: New shipment and a saved shipment refuse decimal boxes by name before they send, and list
  // every refusal. It keys its own order against the shipping fixture customer.
  { name: "shipment-decimal-entry", as: "admin", module: "./flows/shipment-decimal-entry.mjs" },
  // #517: the invoice draft, a receipt batch and the customer page refuse money boxes by name before
  // they send, and list every refusal. Its records belong to the money fixture customer.
  { name: "money-decimal-entry", as: "admin", module: "./flows/money-decimal-entry.mjs" },
  // #517: the customer page's Sales tax rate and a surcharge's Rate override, Accounting's Finance
  // charge and a container type's Tare each refuse a box by name before they send. Its one write is
  // the money fixture customer's Sales tax rate, restored before it ends.
  { name: "rates-decimal-entry", as: "admin", module: "./flows/rates-decimal-entry.mjs" },
  // #495: Pick lists, Container types. Leaving the fixture tote's Tare each box after an Enter save
  // whose reload failed sends nothing more, and the reload after a save reads Show inactive as it
  // is when the read starts. Its one write is the tote's Tare each, put back to none before it ends,
  // and it runs after every flow that picks the tote.
  { name: "pick-list-saves", as: "admin", module: "./flows/pick-list-saves.mjs" },
  // #517: the part page's Each weight, a saved inspection row's Min and a certification's readings
  // refuse a box by name before they send. It writes nothing on the cert fixture part, and keys its
  // own order on that part against the shipping fixture customer for a certification of its own.
  { name: "parts-certs-decimal-entry", as: "admin", module: "./flows/parts-certs-decimal-entry.mjs" },
  // R7: Enter commits a blur-save box as its blur would, the cursor kept in it. The order hub's PO
  // number on an order of its own (shipping fixture customer) saves on Enter with one PATCH and shows
  // Saved; the shipping fixture customer's Credit limit refuses a figure on Enter and sends nothing.
  { name: "enter-saves", as: "admin", module: "./flows/enter-saves.mjs" },
  // The order hub's Qty and Weight (quantity corrections design, section 4): the Saved and Not
  // saved marks, Enter and Restore; what waits or asks first while a value is Not saved (the
  // traveler print gate, the leave prompt, Re-split and Create invoice); and the offered weight on
  // the hub and in both shipment Lines grids. Its part E loses the answer to one line save on
  // purpose, after the server has committed it, and proves that Restore then saves the stored
  // value, and part F loses a rider removal's answer the same way; a failure reported after part E
  // lists each lost write as a request with no response. Part G cuts one answer short, and parts H
  // and I hold a line save while Refresh order before printing reads the order (#550), each after
  // a scan's read of the order that the flow answers 503 itself, which fails no request. It
  // keys its own order against the shipping fixture customer, ships part of it, and invoices
  // nothing: it declines Create invoice, and answers a create request itself, so none reaches the
  // server even when that check fails. It leaves no invoice or payment for `close-month-end` and
  // nothing a later flow reads.
  { name: "hub-line-corrections", as: "admin", module: "./flows/hub-line-corrections.mjs" },
  { name: "cert-results-print", as: "admin", module: "./flows/cert-results-print.mjs" },
  // Round 3 Group B (#165) adds `cert-scope-create`, as admin (needs certs.create + shipping.*,
  // all held via ALL_PERMISSIONS) — raising a certification by hand at a chosen scope, which is
  // the other half of "an implemented route with no button": `POST /api/certs` had no caller
  // anywhere, and SHIPMENT scope had no route at all until this task added
  // `POST /api/shippers/[id]/certs`. Sits beside the other cert flow deliberately. It keys its own
  // order against the shipping fixture customer and ships it (the `cert-results-print` /
  // `ship-partial-then-complete` pattern), finalizes no invoice and touches no period, close or
  // template state, and leaves nothing any later flow reads — so its position is a readability
  // choice, not a dependency.
  { name: "cert-scope-create", as: "admin", module: "./flows/cert-scope-create.mjs" },
  // #693: the hub's Certification required box mints the order-scope cert server-side, and the
  // Certifications section lists it without a reload. Keys its own order against the shipping
  // fixture customer, ships nothing and leaves nothing a later flow reads.
  { name: "cert-required-toggle", as: "admin", module: "./flows/cert-required-toggle.mjs" },
  { name: "void-shipment", as: "admin", module: "./flows/void-shipment.mjs" },
  { name: "credit-hold-block-and-override", as: "clerk", module: "./flows/credit-hold-block-and-override.mjs" },
  { name: "invoice-shipped-order", as: "admin", module: "./flows/invoice-shipped-order.mjs" },
  // Round 3 Group B (#161) adds `reverse-shipment`, as admin (needs `void_shipper`, held via
  // ALL_PERMISSIONS) — the reversing shipment, whose route and service have been complete and
  // 17-test-covered since Phase 4 with no screen able to call either. It creates its own order
  // against the invoicing fixture customer, invoices and FINALIZES it (the only state in which
  // `Order.status = REOPENED` is reachable — this flow is that status's only writer), reverses,
  // then unlocks/voids/re-reverses. Placed here, directly after `invoice-shipped-order` and well
  // before `close-month-end`, for the same reason that flow's own header gives: it ends with its
  // invoice UNLOCKED, so — having no `finalizedAt` — it can never enter the close's readiness or
  // export scope, and its step codes/surcharge are nobody else's fixture to backfill. Nothing
  // after it depends on its state.
  { name: "reverse-shipment", as: "admin", module: "./flows/reverse-shipment.mjs" },
  // #568: on the order hub, a Create invoice whose departure a keystroke in the search box cancels
  // while its request is held still lands, and the hub stays on the order, lists the invoice and
  // closes Create invoice. As admin, it keys and ships its own order for the invoicing fixture
  // customer and leaves one DRAFT invoice, which the run's clean-up removes. It comes after the two
  // flows above, the others that invoice that customer, so neither meets its invoice. A draft has
  // no `finalizedAt`, so `close-month-end`'s readiness, figures and exports never count it; the
  // receivables flow reads its own customer; and `close-month-end` and `quotes` find their rows on
  // /invoicing by their own order numbers, as they do beside every other draft.
  { name: "hub-invoice-reread", as: "admin", module: "./flows/hub-invoice-reread.mjs" },
  // #581: on the saved shipment, a Reverse whose departure a keystroke in the search box cancels
  // while its request is held still lands, and the page stays on the original, reads it again and
  // shows it frozen as a pair. As admin, it keys and ships its own order for the invoicing fixture
  // customer, reverses it, and leaves a live reversed pair and a Partially shipped order with no
  // invoice (REOPENED is written only for an order carrying a finalized invoice), which the run's
  // clean-up removes with that customer's shipments. No invoice means no `finalizedAt`, so
  // `close-month-end`'s readiness, figures and exports never count it, and a Partially shipped
  // order is never an invoicing candidate; the receivables flow reads its own customer.
  { name: "shipment-reverse-reread", as: "admin", module: "./flows/shipment-reverse-reread.mjs" },
  // #587: on a draft invoice, a price typed on the tier-3 Needs price line is refused at Finalize
  // until a step is picked in the line's description box; the pick takes the step's words and,
  // at Save lines, its GL account, and Recalculate keeps both and the typed price. As admin, it keys
  // and ships its own order for its own fixture customer (`stepPickCustomer`) and FINALIZES the
  // invoice, which it leaves finalized: it runs before `close-month-end`, whose readiness, figures
  // and exports count it. The finalized lines are one PART line, which posts nothing, and the
  // picked OPERATION line, which carries the step code's GL account, so readiness finds no gap (the
  // customer opts out of surcharge and tax, so there is no other line); the close's first export is
  // asserted balanced and not to a total, and its second is a delta in which the invoice is
  // unchanged. A failure before the last Finalize leaves a DRAFT, which has no `finalizedAt`, so the
  // close never meets the typed line with no account; the one exception is the first Finalize
  // being accepted where it must be refused, which the flow names as its own failure first. The
  // receivables flow reads its own customer.
  { name: "invoice-step-pick", as: "admin", module: "./flows/invoice-step-pick.mjs" },
  { name: "receivables-apply-age-statement", as: "admin", module: "./flows/receivables-apply-age-statement.mjs" },
  // Separate fixtures are reaped after this flow (including failure), before month-end can run.
  { name: "draft-recovery", as: "admin", module: "./flows/draft-recovery.mjs" },
  { name: "close-month-end", as: "admin", module: "./flows/close-month-end.mjs" },
  { name: "quotes", as: "admin", module: "./flows/quotes.mjs" },
  // Task 8 (Phase 8A) adds the 21st and now-last flow, `reports`, as admin — the read-only proof of
  // the reports platform: reach /reports via the nav, confirm the catalog (six native reports + the
  // two homed cross-area entries), open the Backlog report and filter + Excel-export it (the export
  // path shared by every report), then drive the Comparison scoreboard's figures and its This-week /
  // This-month presets. It creates NOTHING — no order/invoice/fixture, no seeded/shared mutation — so
  // it needs no db-fixtures reap entry and runs last for the usual nothing-after-needs-its-state
  // reason; being purely a read, it is safe after whatever period/close state the tail leaves behind.
  { name: "reports", as: "admin", module: "./flows/reports.mjs" },
  { name: "setup-checklist", as: "admin", module: "./flows/setup-checklist.mjs" },
  // PR 12: Users and Roles in their tabs. Its one user and one role are reaped by exact name.
  { name: "people-admin", as: "admin", module: "./flows/people-admin.mjs" },
  { name: "numbered-recipes", as: "admin", module: "./flows/numbered-recipes.mjs" },
  { name: "process-traveler-editor", as: "admin", module: "./flows/process-traveler-editor.mjs" },
  // #348: re-signs in on a non-loopback HTTP origin, a real insecure context, and drives the
  // controls the owner reported dead there. It creates its own part and order under the owned
  // order customer (reaped by exact natural key). Its step uses step code B, never A, so
  // blocked-code-delete's exact count for A does not depend on where this entry sits.
  { name: "insecure-origin", as: "admin", module: "./flows/insecure-origin.mjs" },
  // The owner's two examples (the weights design §14). As admin, it keys two orders of its own
  // for the shipping fixture customer, with the container types and the part the fixture set
  // makes for it, and prints from them with the screens' own buttons. It leaves those orders and
  // the pages it stored, which the run's clean-up removes. It invoices nothing and posts nothing,
  // so the month close-month-end leaves closed does not stop it. It runs after every flow but
  // templates-admin, so that no flow before it sees an order number it takes or a row it leaves;
  // templates-admin reads none of them (it picks its own order by its own number).
  { name: "weights-two-examples", as: "admin", module: "./flows/weights-two-examples.mjs" },
  // Task 16 (Phase 7) added `templates-admin`, as admin — the template-designer screens: reach
  // /admin/templates via the nav, see the 8 document types with their Standard defaults starred,
  // create/publish/re-draft a template, design a traveler on the canvas and print it, then
  // re-log-in as the restricted view-only user to prove the nav decision + §5.16. Its templates are
  // reaped by name in db-fixtures.ts, its order by the fixture customer, and its customer
  // assignment is cleared in the flow. It makes one DRAFT invoice of its own order and prints it
  // (PR 3 of the invoice canvas lane), which is safe after the CLOSED month close-month-end leaves
  // behind by construction, the quotes flow's reasoning above: `createInvoice` and a draft's print
  // are not posting mutations, so `assertPeriodOpen` never guards them; a draft has no
  // `finalizedAt`, so it never enters the close's figures; and a draft's print files no copy in the
  // customer's folder. The invoice is reaped through `deleteInvoicesAndLines` by the fixture
  // customer.
  // It runs last but for backups (PR C of #926, ruling C22): its canvas print needs an order of the fixture
  // customer, entered on E2E-PART-1, and entering it locks that part's current process revision.
  // process-traveler-editor (process-traveler-editor.mjs:216) expects that revision still working,
  // so every flow that reads the fixture part's revision state runs before this one.
  // Its first step waits for the backup banner, which the backups flow below clears for the rest of
  // the run (its fresh archive stays in the harness's BACKUP_DIR), so backups comes after it.
  { name: "templates-admin", as: "admin", module: "./flows/templates-admin.mjs" },
  // Task 9 (Phase 8C) adds the 23rd and now-last flow, `backups`, as admin (needs
  // `manage_backups`, held via ALL_PERMISSIONS) — the only place the real host `pg_dump` binary is
  // exercised (vitest injects a fake dump command so the suite never depends on a host major
  // matching the postgres:18 server). It mutates only the harness-owned BACKUP_DIR, never a
  // seeded/shared DB fixture, so it needs no db-fixtures reap entry and runs last for the usual
  // nothing-after-needs-its-state reason; no flow before it may need the banner it clears, and
  // templates-admin, the one that asserts that banner, runs just before it (ruling C22).
  { name: "backups", as: "admin", module: "./flows/backups.mjs" },
  // Release updates (PR 3): writes a status file into the harness's update folder and drives the
  // banner, Hold, What's new, as admin and then as the restricted user. It restores everything it
  // touches before it ends (the files, the hold row, the users' last-seen version), so no flow
  // after it could see a banner or a dialog, and it runs last, after backups, so the banners it
  // draws cannot sit above any flow that reads the rail's fit or the backup banner.
  { name: "release-updates", as: "admin", module: "./flows/release-updates.mjs" },
];

// Only the explicitly supported process subset can be selected; all normal guards still run.
const activeFlows = selectProcessFlows(FLOWS, process.env.E2E_FLOWS);

// Mutable, module-level: both main()'s own finally block and the SIGINT/SIGTERM handlers below
// need to reach whatever's currently been acquired, and a signal can land at any point during
// main()'s execution — there is no single function-local scope both paths share.
//
// `created.receivablesBatchId` (Task 17, Phase 5B): a `ReceiptBatch` has no customer column of
// its own (unlike an Order/Invoice/Shipper/Cert), so `deleteReceivables` (db-fixtures.ts) can only
// FIND one via a live `Payment` referencing it — a batch this flow created but never got as far as
// adding a payment to (a crash, or a selector bug — exactly what happened once during this task's
// own development) is otherwise invisible to both `cleanup()` and `reapLeftovers()`'s customer-
// scoped sweeps, forever. The `receivables-apply-age-statement.mjs` flow records its own batch's
// id here the moment it reads it back off the URL (a live-built row's id is only known once the
// flow that created it has run), so `cleanup()` below has an id-driven backstop alongside the
// payment-scoped sweep. Still not airtight: a crash hard enough
// to skip this module's own `finally { await teardown(); }` (never SIGTERM, no live process) loses
// this in-memory value the same way it loses everything else not yet written to the dev DB.
// `created.closeBatchId`/`closePeriodYear`/`closePeriodMonth` (Task 9, Phase 5C): the
// close-month-end flow's own id-driven cleanup backstops, the SAME reasoning as
// `receivablesBatchId` above but kept as separate fields (never reusing `receivablesBatchId`) so
// the two A/R flows' backstops can never clobber each other if both are live in one run.
const state = {
  devServer: null, browser: null, fixtures: null,
  cancelled: false,
  // #326: the per-run temp dir prepareProductionServer() lays the standalone server out into
  // (production mode only — stays null in dev). Removed by teardown() once the server has stopped.
  standaloneDir: null,
  // #335: that preparation's own promise, from the moment main() starts it. teardown() waits for it
  // to settle before it reads standaloneDir, so it never reads the directory before it is
  // recorded and never removes the tree under a copy still in flight.
  preparing: null,
  created: {
    orderId: null, orderNumber: null, receivablesBatchId: null,
    closeBatchId: null, closePeriodYear: null, closePeriodMonth: null,
    draftRecovery: null,
  },
  cleanupFailed: null,
  // #184 fix (c): every dev-DB write a flow makes that the browser's own request/response events
  // CANNOT see, and which the retry gate would therefore mistake for "this flow changed nothing".
  // Two kinds, not one — the round-1 comment here claimed `ctx.lockRevision` was "the only
  // out-of-band write", and that was false:
  //
  //   * `ctx.lockRevision` — a direct dev-DB write through the fixtures CLI (revision-cut calls it
  //     to stand in for Phase 3's order save). Never touches the browser at all.
  //   * `ctx.apiMutate` — a Playwright APIRequestContext call (`page.request.*`). It goes over the
  //     wire to the same server, but it is issued from THIS process rather than from the page, and
  //     Playwright emits no `context` request/response event for it. `templates-admin` makes one
  //     (a competing draft PATCH); it was invisible to the counters until this fix round, latent
  //     only because that flow has already mutated through the UI by the time it runs — which
  //     nothing pinned. `assertNoRawApiMutations` now refuses any raw one at startup.
  //
  // `indeterminate` is the dangerous half and is incremented BEFORE the call: a request that never
  // answers may have committed server-side anyway. runFlow snapshots both before the attempt and
  // diffs them after.
  outOfBand: { committed: 0, indeterminate: 0 },
};
let teardownPromise = null;

function runDbScript(command, payload) {
  const args = ["tsx", path.join("e2e", "lib", "db-fixtures.ts"), command, JSON.stringify(payload ?? {})];
  const out = execFileSync("npx", args, { cwd: ERP_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const line = out.trim().split("\n").filter(Boolean).pop();
  return line ? JSON.parse(line) : null;
}

/** Binds `port` briefly to find out whether something's already listening on it — the standard
 *  idiomatic Node check (attempting to bind, not attempting to connect, is authoritative: a
 *  service that's up but not yet accepting connections would otherwise read as "free"). */
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

async function waitForServer(url, timeoutMs, devServer) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // next dev silently falls back to the next free port (3101, 3102, ...) instead of failing
    // when the requested one is taken — polling BASE_URL would then time out after the full
    // 60s with no clue why. Catch that from its own announced output instead of waiting it out.
    const portMismatch = devServer.getOutput().match(/Port (\d+) is in use, trying (\d+) instead/);
    if (portMismatch) {
      throw new Error(
        `next dev could not bind port ${portMismatch[1]} (already in use) and fell back to ` +
        `port ${portMismatch[2]} instead — refusing to continue against the wrong port. Free ` +
        `port ${PORT} (an orphaned dev server from a previous run? \`fuser -k ${PORT}/tcp\`) ` +
        `and re-run.`,
      );
    }
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // connection refused while next dev is still booting — keep polling
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url} to come up`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * #326: build once, then lay the server out the way the Dockerfile's runtime stage does
 * (STANDALONE_COPIES, pinned to the Dockerfile by tests/e2e-server-mode.test.ts) in a per-run
 * temp dir that teardown removes. A failed build is a named refusal before any fixture exists.
 *
 * #335: the directory is recorded before anything is copied into it, and each copy first reads
 * the cancellation latch, so a cancelled preparation settles after at most the one copy already
 * in flight. teardown() waits for that (state.preparing). The build itself stays a blocking call:
 * a signal sent to this process alone waits until the build returns.
 *
 * #445: a cancelled build is not reported as a failed one. Ctrl-C reaches the whole process group,
 * so the build dies of the signal and the blocking call throws before this process has run its own
 * handler: read in the catch directly, the latch is still false (measured). The catch therefore
 * yields the same two turns main() yields after the pre-flight, then reads the latch, and returns
 * without the refusal when it is set; the handler has already said why the run is ending. A build
 * that fails with no signal refuses as before, two turns later.
 */
async function prepareProductionServer() {
  const started = Date.now();
  try {
    execFileSync("npx", ["next", "build"], { cwd: ERP_ROOT, stdio: ["ignore", "inherit", "inherit"] });
  } catch (err) {
    for (let turn = 0; turn < 2; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    if (state.cancelled) return;
    throw new Error(`Refusing to run the flows: next build failed (${err?.message ?? err}). Its output is above.`);
  }
  console.log(`  next build finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  state.standaloneDir = await mkdtemp(path.join(os.tmpdir(), "heatsynq-e2e-standalone-"));
  for (const { from, to } of STANDALONE_COPIES) {
    if (state.cancelled) return;
    await cp(path.join(ERP_ROOT, from), path.join(state.standaloneDir, to), { recursive: true });
  }
}

// `--disable-source-maps`, and the measurements that chose it. Applies to the dev branch of
// startServer() below; the production branch runs the standalone server.js built above.
//
// The warm-up compiles all 243 routes into ONE `next dev`, and that costs GIGABYTES — this is the
// suite's largest single resource cost, not a rounding error. Measured on this app (one dev
// server, routes issued sequentially in warm-up order, RSS sampled per route):
//
//     baseline                    9722 MB peak, 119.2 s
//     --disable-source-maps       8821 MB peak, 107.6 s   <- chosen
//     --webpack                   8565 MB peak, 279.4 s
//     --max-old-space-size=3072   9734 MB peak, 120.0 s
//
// Three things that table settles, so nobody re-derives them:
//   * A NODE HEAP CAP DOES NOTHING. `next dev` is Turbopack, whose allocation is native (Rust), so
//     `--max-old-space-size` governs none of it — 9734 against a 3 GB cap is the whole argument.
//     Do not "fix" a future memory problem here by capping the heap.
//   * `--webpack` bought 12% of the memory for 2.3x the wall clock, which would eat the warm-up
//     budget. Rejected on time, not on principle — ON 16.2.x, where this table was measured. On
//     16.3.x Turbopack `next dev` regressed (#209, below), so the nightly opted into webpack
//     through E2E_DEV_WEBPACK=1 (resolveDevBundler) until the owner's ruling of 2026-10-08 took
//     the knob out of its workflow (below); a dev-mode run is Turbopack unless the knob is set.
//   * Source maps are the one cheap win: ~900 MB and ~10% faster. The cost is poorer stack traces
//     in `e2e-artifacts/dev-server.log`, which is an acceptable trade HERE and only here — a flow
//     is diagnosed from its `requestfailed` records, screenshots and assertion text, none of which
//     this touches. It is a flag on the E2E server alone; `npm run dev` is untouched.
//
// The peak is dominated by the FIRST page compiled (~4.6 GB — the root layout, shell and shared
// client graph, not that page specifically); the other 242 routes add ~5 GB between them.
//
// **That table was measured SEQUENTIALLY, and the line this file prints at runtime is not.** The
// real warm-up runs at concurrency 4, against a tree that keeps moving; two runs on 2026-09-07 read
// 7292 and 7189 MB where this table says 8821. Neither is wrong — they are different instruments on
// different trees — so compare a live run against another live run, never against this table. The
// same day's re-measurement settled what those figures had left open: `--disable-source-maps` does
// NOT rescue 16.3.4, which spends ~273 MB per API ROUTE against 16.2.12's ~26 MB and blows past
// 13.7 GB after 91 of 243 routes. HANDOFF §4 (2026-09-07) carries both halves.
//
// **16.3.6 kept that regression, and the project adopted it anyway (#209, owner 2026-09-25)**,
// because the required check runs the production server and never meets it. The probe stopped
// 16.3.6 at its 11,000 MiB ceiling after 80 of 251 routes (docs/execution/2026-09-25-next1636-probe).
// So E2E_DEV_WEBPACK=1 appends `--webpack` here, and only here, and the nightly set it from then
// until the ruling of 2026-10-08 (below).
//
// **On 16.4.0 (owner ruling 2026-10-07) the Turbopack warm-up completes.** That day's probe warmed all
// 236 routes on it twice, at 4,461 and 4,409 MiB, and stopped 16.3.6 at the same ceiling after 71
// of the same 236 (docs/execution/2026-10-07-next164-probe). It measured this warm-up and the
// build, and nothing after them: it ran no flow, and never webpack. A local
// `npm run test:e2e:dev` without the knob runs Turbopack, and one such run passed whole on 16.4.0
// (2026-10-07, dev laptop, HANDOFF §4).
//
// **The nightly is back on Turbopack (owner ruling 2026-10-08, "Restore on Turbopack").** Its
// workflow no longer sets the knob, and its schedule is restored, on those two results. When the
// ruling was made the workflow itself had not run on 16.4.0, and no dev-mode run on 16.4.0 had
// been made on the desktop that takes it. The knob stays here as a local escape hatch, and
// tests/e2e-server-mode.test.ts still pins it. manual-capture.mjs spawns its own `next dev` and
// reads no knob. HANDOFF §4 (2026-09-25, 2026-10-07 and 2026-10-08) records both adoptions, the
// webpack nightly's measurement on 16.3.6, and the restoration.
//
// Both arms hand the server the harness's own share (#588) as they hand it BACKUP_DIR, over the
// process environment (and over `.env`: Next keeps a value the server was started with), so a
// developer's own share is never the one written to. tests/e2e-office-share.test.ts runs this
// function in both modes and reads what it passed.
function startServer() {
  const [command, args, cwd, env] = SERVER_MODE === "dev"
    ? ["npx", devServerArgs(PORT, DEV_BUNDLER), ERP_ROOT,
      { ...process.env, PORT: String(PORT), BACKUP_DIR, OFFICE_SHARE_DIR, OFFICE_SHARE_ROOT, UPDATES_DIR }]
    : ["node", ["server.js"], state.standaloneDir,
      serverEnv(readFileSync(path.join(ERP_ROOT, ".env"), "utf8"), process.env,
        { PORT: String(PORT), HOSTNAME: "127.0.0.1", BACKUP_DIR, OFFICE_SHARE_DIR, OFFICE_SHARE_ROOT, UPDATES_DIR })];
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so killDevServer can take down webpack's worker processes with it, not
    // just the `next`/`node` wrapper.
    detached: true,
  });
  let out = "";
  // #184 fix (b). Two consumers, deliberately: the in-memory string is what waitForServer's
  // port-fallback detection greps and what the startup-failure path dumps to the console, and the
  // file is the artifact a reviewer reads afterwards. Appending as the data arrives (rather than
  // writing `out` once at teardown) means a run that is SIGKILLed, OOM-killed or that hangs still
  // leaves the log on disk — which is precisely the case #184 left nobody able to diagnose.
  const logStream = createWriteStream(DEV_SERVER_LOG, { flags: "a" });
  logStream.on("error", (err) => console.error(`  (could not write ${DEV_SERVER_LOG}: ${err})`));
  logStream.write(`[e2e] server mode: ${SERVER_MODE}${SERVER_MODE === "dev" ? ` (${DEV_BUNDLER})` : ""}\n`);
  const record = (d) => { const text = d.toString(); out += text; logStream.write(text); };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.getOutput = () => out;
  child.closeLog = () => new Promise((resolve) => logStream.end(resolve));
  return child;
}

/**
 * PEAK resident memory of the dev server, in MB — the whole PROCESS GROUP, not just the `npx`
 * wrapper, and the high-water mark rather than a sample.
 *
 * **Why `VmHWM` and not `ps rss` (Codex review, MR !268).** This started as one `ps` sample taken
 * after `warmRoutes` resolves, which reports whatever RSS happens to be current at that instant —
 * so a transient peak during one of the four concurrent compilations, or memory released (or a
 * worker exited) before the sample, simply would not appear. A diagnostic whose whole job is to
 * expose memory regressions must not be able to miss the peak it exists to report, and the gap is
 * real, not theoretical: one probe run recorded a 8821 MB peak against an 8767 MB final reading.
 * `/proc/<pid>/status`'s `VmHWM` is the kernel's own peak-RSS counter, so it needs no sampling
 * loop and has no window to miss.
 *
 * The wrapper holds ~70 MB while the `next-server` child holding the compiled graph holds
 * gigabytes, so reading `child.pid` alone would be actively misleading, not merely imprecise.
 * `startServer` spawns detached, so the group id IS the child's pid — which is what makes the
 * whole tree addressable.
 *
 * Summing per-process high-water marks is deliberately an UPPER bound on the group's simultaneous
 * peak: two processes may have peaked at different moments. That is the right direction for a
 * regression tripwire, and in practice one process dominates so completely that the distinction is
 * academic here.
 *
 * **But VmHWM alone is NOT sufficient, which is why the caller also samples.** A process that has
 * already exited is gone from `/proc` and contributes nothing, and `next dev` spawns transient
 * compile workers that do exactly that. Measured while warming 50 routes: a sampling loop saw
 * 8087 MB, while VmHWM read afterwards reported 8001 MB — the difference being a worker that had
 * come and gone. So this covers peaks a sampler's gaps would miss, the sampler covers processes
 * this can no longer see, and `devServerMemoryMeter` reports the larger of the two. Neither half
 * is redundant.
 *
 * Best-effort and never throws: no run should fail because `ps` or `/proc` was unavailable, in
 * which case the caller simply prints no line. Linux-only, matching every other assumption in this
 * harness (process groups, SIGTERM, `fuser`).
 */
function devServerPeakRssMb(child) {
  if (!child?.pid) return 0;
  try {
    const out = execFileSync("ps", ["-eo", "pgid=,pid="], { encoding: "utf8" });
    let kb = 0;
    for (const line of out.split("\n")) {
      const [pgid, pid] = line.trim().split(/\s+/);
      if (Number(pgid) !== child.pid || !pid) continue;
      try {
        // VmHWM — the kernel's own peak-RSS counter for the process, not a sample.
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        kb += Number(status.match(/^VmHWM:\s+(\d+) kB$/m)?.[1] ?? 0);
      } catch {
        // This PID vanished between the `ps` listing and the read. That is the EXPECTED case here,
        // not an anomaly — the transient compile workers are the whole reason this function is
        // paired with a sampler — so it must skip the dead process and keep every reading already
        // collected. Letting it reach the outer catch would return 0 and discard the long-lived
        // server's high-water mark, which is the one figure that actually matters.
      }
    }
    return Math.round(kb / 1024);
  } catch {
    return 0;
  }
}

/** Instantaneous resident memory of the dev server's process group, in MB. The sampler's half of
 *  `devServerMemoryMeter` — it sees transient workers that `VmHWM` loses when they exit. */
function devServerRssMb(child) {
  if (!child?.pid) return 0;
  try {
    const out = execFileSync("ps", ["-eo", "pgid=,rss="], { encoding: "utf8" });
    let kb = 0;
    for (const line of out.split("\n")) {
      const [pgid, rss] = line.trim().split(/\s+/);
      if (Number(pgid) === child.pid) kb += Number(rss) || 0;
    }
    return Math.round(kb / 1024);
  } catch {
    return 0;
  }
}

/**
 * Watches the dev server's memory across a phase and reports the peak, combining BOTH readings for
 * the reason in `devServerPeakRssMb`'s docblock: polling catches processes that exit before the
 * end, `VmHWM` catches spikes between polls. `stop()` returns the larger.
 *
 * Diagnostic only — it never throws and never fails a run. The interval is `unref`d so it can
 * never hold the process open, and 500 ms costs two small reads against a phase that runs for
 * tens of seconds.
 */
function devServerMemoryMeter(child) {
  let peak = 0;
  const sample = () => { const mb = devServerRssMb(child); if (mb > peak) peak = mb; };
  sample();
  const timer = setInterval(sample, 500);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      sample();
      return Math.max(peak, devServerPeakRssMb(child));
    },
  };
}

/** Only positive absence of the owned process group releases DB cleanup. A leader's exit
 * or a delivered signal does not prove that its workers stopped. Each escalation phase is
 * bounded; an inaccessible or surviving group is a cleanup failure, never success. */
async function killDevServer(child, timeoutMs = 5000) {
  if (!child) return;
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error("Cannot establish the owned dev-server process group");
  }
  const group = -child.pid;
  const absent = () => {
    try {
      process.kill(group, 0);
      return false;
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
  };
  const signal = (name) => {
    try { process.kill(group, name); }
    catch (error) { if (error?.code !== "ESRCH") throw error; }
  };
  const waitForAbsence = async () => {
    const deadline = Date.now() + timeoutMs;
    while (!absent()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
    }
    return true;
  };
  if (absent()) return;
  signal("SIGTERM");
  if (await waitForAbsence()) return;
  signal("SIGKILL");
  if (await waitForAbsence()) return;
  throw new Error(`Owned dev-server process group ${child.pid} is still present; refusing DB cleanup`);
}

/**
 * The one teardown path — dev server, dev-DB fixtures, browser — shared by main()'s own finally
 * block AND the SIGINT/SIGTERM handlers below, so a signal that lands mid-run and one that lands
 * after a clean finish never race each other into doing it twice.
 *
 * Single-flight via a cached PROMISE, not a boolean flag: an earlier version used `if (tornDown)
 * return;` with `tornDown` set synchronously up front, which made a second caller return
 * immediately without ever awaiting the first caller's in-flight work. In practice that let a
 * SIGINT during a flow race main()'s own error path: the signal handler's teardown() call "won"
 * (set the flag first) and started actually closing things, but main()'s interrupted `await` woke
 * up, propagated an error through runFlow, hit main()'s `finally { await teardown(); }` — which,
 * seeing the flag already set, returned INSTANTLY rather than waiting — and let main()'s own
 * rejection settle and the process look "idle" before the signal handler's kill-server/cleanup-
 * fixtures steps had actually run. Caching the promise itself means every caller awaits the exact
 * same in-flight (or already-settled) work, so nothing can observe teardown as "done" before it
 * is. killDevServer and the DB cleanup — the two steps that matter most for not leaking anything
 * — run before the (slower, less consequential if it lingers a moment) browser.close().
 */
function teardown() {
  if (!teardownPromise) {
    teardownPromise = (async () => {
      // #335: a signal during setup starts this while the standalone preparation is still running.
      // Wait for it to settle; its own failure is main()'s to report, not a cleanup failure.
      if (state.preparing) {
        try { await state.preparing; } catch { /* reported by main() */ }
      }
      const failed = (step, error) => {
        const message = `${step}: ${error}`;
        state.cleanupFailed = state.cleanupFailed ? `${state.cleanupFailed}; ${message}` : message;
        process.exitCode = 1;
        console.error(`  cleanup FAILED — ${message}`);
      };
      let writersStopped = !state.devServer;
      if (state.devServer) {
        try {
          await killDevServer(state.devServer);
          writersStopped = true;
        } catch (error) {
          failed("owned-server termination unproven; DB cleanup refused", error);
        }
        // Log/browser closure remain attempted even when worker termination cannot be proved.
        try { await state.devServer.closeLog?.(); }
        catch (error) { failed("dev-server log closure", error); }
      }
      if (state.fixtures && writersStopped) {
        console.log("\nCleaning up dev-DB fixtures (erp)...");
        try {
          runDbScript("cleanup", {
            ...state.fixtures,
            receivablesBatchId: state.created.receivablesBatchId,
            closeBatchId: state.created.closeBatchId,
            closePeriodYear: state.created.closePeriodYear,
            closePeriodMonth: state.created.closePeriodMonth,
          });
          console.log("  cleanup ok");
        } catch (error) {
          failed("dev DB may still hold E2E fixture rows", error);
        }
      }
      if (state.browser) {
        try { await state.browser.close(); }
        catch (error) { failed("browser closure", error); }
      }
      // After the server stopped (above): it runs from this directory.
      if (state.standaloneDir && writersStopped) {
        try { await rm(state.standaloneDir, { recursive: true, force: true }); }
        catch (error) { failed("standalone server tree cleanup", error); }
      }
      try { await rm(BACKUP_DIR, { recursive: true, force: true }); }
      catch (error) { failed("backup artifact cleanup", error); }
      // #588: the share the invoice flow filed into, removed as the backup folder is.
      try { await rm(OFFICE_SHARE_DIR, { recursive: true, force: true }); }
      catch (error) { failed("customer folder share cleanup", error); }
    })();
  }
  return teardownPromise;
}

function installSignalHandlers() {
  const cancel = (reason) => {
    // Teardown is asynchronous: an in-flight attempt can settle while it is still cleaning up.
    // Latch cancellation before starting it so that continuation cannot dispatch more work.
    state.cancelled = true;
    process.exitCode = 1;
    console.error(`\n${reason} — cleaning up (dev server + dev-DB fixtures) before exit...`);
    teardown()
      .catch((err) => console.error("Error during signal teardown:", err))
      .finally(() => process.exit(1));
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => cancel(`Received ${signal}`));
  // A throw that escapes a flow's own await (an async route or dialog handler) never reaches
  // runFlow's catch. Node's default for it exits mid-run with NO teardown: the server keeps its
  // port and the dev-DB fixtures stay. It is not attributable to a flow, so it ends the run the
  // way a signal does, red and cleaned up.
  for (const event of ["uncaughtException", "unhandledRejection"]) {
    process.on(event, (error) => {
      console.error(`\n${event}: ${error?.stack ?? error}`);
      cancel(`Fatal ${event}`);
    });
  }
}

// #184 fix (c). The predicates that decide whether a red run may become a green one —
// `classifyFailure`, `retryRefusal`, `isSessionEndpoint`, and the sweep that says what the
// mutation counters can even SEE — live in e2e/lib/failure-classify.mjs, where
// tests/e2e-harness.test.ts can reach them. They were module-private here, so nothing guarded the
// next edit to them; the round-1 proofs were injected by hand and reverted.

/**
 * The self-enforcing half of fix-round finding 1. `context.on("request"/"response")` sees only
 * requests issued FROM A PAGE — a `page.request.patch(...)` is issued by the Playwright process
 * and emits no context event at all, so a flow can mutate the dev DB with the retry gate's
 * counters reading zero. Refuse the whole run on a raw one, before flow 1, in the second it takes
 * to read 25 files: a named refusal up front beats a wrong retry decision at flow 20.
 * `ctx.apiMutate` is the counted way to make the same call.
 */
async function assertNoRawApiMutations() {
  // #192: the flow files AND the shared lib helpers, not the flows alone — a bad locator or a raw
  // mutation in `boardRow`/`assertNeverVisible` (both in e2e/lib/) was invisible to every sweep while
  // being worse than the same line in one flow. suite-sources.mjs owns the file set and its two
  // detector-file exclusions, read identically here and in tests/e2e-harness.test.ts.
  const sources = await suiteSources(__dirname);
  const raw = [], rows = [], absences = [], throws = [], routes = [], reads = [];
  for (const { relPath, source } of sources) {
    const at = (hit) => `  e2e/${relPath}:${hit.line}  ${hit.snippet}`;
    for (const hit of findRawApiMutations(source)) raw.push(at(hit));
    for (const hit of findAmbientRowLocators(source)) rows.push(at(hit));
    for (const hit of findUncheckedAbsenceAssertions(source)) absences.push(at(hit));
    for (const hit of findPlainErrorFailures(source)) throws.push(at(hit));
    for (const hit of findRawRouteCalls(source)) routes.push(at(hit));
    for (const hit of findBareReads(source)) reads.push(at(hit));
  }
  if (raw.length > 0) {
    throw new Error(
      `${raw.length} raw APIRequestContext call(s) in the suite sources. Playwright emits NO ` +
      `context request/response event for these, so the retry gate's mutation counters cannot ` +
      `see them and would happily re-run a flow that had already written to the dev DB:\n` +
      `${raw.join("\n")}\n` +
      `Route a mutating one through ctx.apiMutate(page, url, { method, data }) — which IS ` +
      `counted — or, for a read, the page's request context's get with { maxRetries: 1 } (#843).`,
    );
  }
  // The two green-run-proving-nothing shapes (#167a fix round, e2e/lib/flow-lint.mjs). Refused
  // here for the same reason as the one above: a named refusal in the second it takes to read the
  // flow files beats a flow that passes for the wrong reason and is believed.
  if (rows.length > 0) {
    throw new Error(
      `${rows.length} order-board row locator(s) built straight off \`page\` and filtered by an ` +
      `order number. The board prints six other bare-number columns beside it (PO, Qty, Weight, ` +
      `Loads, VS #), so this matches whichever row happens to hold those digits ANYWHERE — it ` +
      `went red for real once, and inside an assert.rejects it PASSES instead:\n` +
      `${rows.join("\n")}\n` +
      `Use boardRow(page, orderNumber) from e2e/lib/orders.mjs — it matches the order-number CELL.`,
    );
  }
  if (absences.length > 0) {
    throw new Error(
      `${absences.length} absence assertion(s) written as assert.rejects(...waitFor(...)). That ` +
      `passes on ANY rejection — including Playwright's strict-mode violation — so the assertion ` +
      `swearing an element is gone reports SUCCESS the moment the locator matches it twice:\n` +
      `${absences.join("\n")}\n` +
      `Use assertNeverVisible(locator, message[, timeoutMs]) from e2e/lib/ui.mjs, which requires ` +
      `the rejection to be the timeout.`,
    );
  }
  // #193: a flow assertion written as `throw new Error(...)` carries no ERR_ASSERTION code, so
  // classifyFailure's hard override does not cover it — a stale netFailure earlier in the flow can
  // launder it into FAIL [network] and, in a mutation-free flow, a granted retry.
  if (throws.length > 0) {
    throw new Error(
      `${throws.length} flow failure(s) minted as a code-less Error (thrown or rejected). That carries ` +
      `no ERR_ASSERTION code, so classifyFailure cannot tell it from a transport failure and a stale ` +
      `netFailure can launder it into a green retry:\n` +
      `${throws.join("\n")}\n` +
      `Use assert.ok / assert.match / assert.fail (node:assert/strict), or for a promise rejection ` +
      `reject(new assert.AssertionError({ message })) — keep the message text; the AssertionError is ` +
      `what the override covers.`,
    );
  }
  // #342: a route registered or removed straight on a page. While a page has any route Playwright
  // intercepts all its requests, and it stops when the last route goes; a request the page issues
  // in that instant never settles, and the flow fails far from the cause (#340).
  if (routes.length > 0) {
    throw new Error(
      `${routes.length} request route(s) registered or removed without the keep-alive. Removing a ` +
      `page's last route turns Playwright's interception off, and a request the page issues in ` +
      `that instant never reaches the server and never settles:\n` +
      `${routes.join("\n")}\n` +
      `Use routeRequests(page, url, handler) from e2e/route-keep-alive.mjs, and call the function ` +
      `it returns to remove the route.`,
    );
  }
  // #843: a read through the request context that does not ask for one retry of a reset socket.
  // The pooled keep-alive socket it rides is closed by the server after 6 s idle, and a reuse
  // landing on that close resets; a flow that has mutated is then red with no retry.
  if (reads.length > 0) {
    throw new Error(
      `${reads.length} read(s) through the request context without one retry of a reset socket. ` +
      `A reuse of the pooled keep-alive socket can land on the server closing it (socket hang up), ` +
      `and a flow that has mutated is not retried:\n` +
      `${reads.join("\n")}\n` +
      `Pass { maxRetries: 1 } to page.request.get, which replays a reset read once and nothing else.`,
    );
  }
  return sources.length;
}

async function runFlow(browser, flow, ctx, attempt) {
  // Attempt 1 keeps the historical path so nothing that reads `e2e-artifacts/<flow>/` moves; a
  // retry gets its OWN directory, because the failed attempt's screenshots and video are the
  // whole reason the retry is allowed to be reported at all.
  const flowDir = path.join(ARTIFACTS_DIR, attemptDir(flow.name, attempt));
  await mkdir(flowDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    recordVideo: { dir: flowDir, size: { width: 1280, height: 900 } },
  });

  // Context-level (not page-level) so a popup or a second tab a flow opens is instrumented too —
  // and that is the whole of what these events cover. Playwright emits them ONLY for requests
  // issued from a page: navigations (including navigation POSTs), fetch/XHR from page script, and
  // sub-resources. An `APIRequestContext` call (`page.request.*`) is issued from the Playwright
  // process and produces NO event here — hence `ctx.apiMutate` and the startup sweep that refuses
  // a raw one. Verified clean and worth stating, since a future reader will ask: the flows use no
  // `navigator.sendBeacon` and register no service worker, so nothing else escapes these counters.
  //
  // `committed` is the count the retry decision turns on: a mutating, non-session request that
  // came back 2xx definitely changed the dev DB, so re-running the flow from step 1 would
  // duplicate it. `indeterminate` is the count that must ALSO be zero — a mutating request that
  // got no response at all may well have committed server-side before the connection dropped, and
  // an in-flight one at the moment of failure is no better known. `attempted - answered` captures
  // both without needing to know which.
  // Each netFailure is stamped, so the printed evidence can say how long before the throw it
  // happened. The classifier deliberately does not use that (see failure-classify.mjs — no time
  // window, and why), but a human reading a RETRIED line should be able to judge the causality it
  // declines to guess at.
  const flowStarted = Date.now();
  const netFailures = [];
  let attempted = 0, answered = 0, committed = 0;
  context.on("request", (request) => {
    if (MUTATING_METHODS.has(request.method()) && !isSessionEndpoint(request.url())) attempted += 1;
  });
  context.on("response", (response) => {
    const request = response.request();
    if (!MUTATING_METHODS.has(request.method()) || isSessionEndpoint(request.url())) return;
    answered += 1;
    if (response.status() >= 200 && response.status() <= 299) committed += 1;
  });
  context.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "unknown";
    if (IGNORED_REQUEST_FAILURE.test(errorText)) return;
    netFailures.push({ at: Date.now(), line: `${request.method()} ${request.url()} — ${errorText}` });
  });
  const outOfBandBefore = { ...state.outOfBand };
  // Next dev compiles each route on its first hit; under a loaded machine (this harness itself
  // launches a fresh next dev + Chromium per run) that first compile can occasionally outrun
  // Playwright's 30s default. Generous, not unlimited — a genuinely hung page still times out.
  context.setDefaultNavigationTimeout(60000);
  context.setDefaultTimeout(45000);
  const page = await context.newPage();

  let shotIndex = 0;
  const shot = async (label) => {
    shotIndex += 1;
    const file = path.join(flowDir, `${String(shotIndex).padStart(2, "0")}-${label}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  };

  console.log(`\n=== ${flow.name} (as ${flow.as})${attempt > 1 ? ` [attempt ${attempt}]` : ""} ===`);
  let ok = true;
  let error = null;
  let contextClosed = false;
  try {
    // Both sets of credentials come from the fixtures this run created. The full-permission ones
    // used to be a hardcoded `admin`/`admin` — the seeded pair README §"first run" tells you to
    // change after first login, so the four flows using them broke for any developer who did.
    const creds = flow.as === "restricted"
      ? { username: ctx.fixtures.restrictedUsername, password: ctx.fixtures.restrictedPassword }
      : flow.as === "clerk"
        ? { username: ctx.fixtures.clerkUsername, password: ctx.fixtures.clerkPassword }
        : { username: ctx.fixtures.adminUsername, password: ctx.fixtures.adminPassword };
    await login(page, ctx.baseURL, creds.username, creds.password);
    await shot("logged-in");

    const mod = await import(flow.module);
    if (flow.name === "draft-recovery") {
      const { prepareDraftRecoveryFixtures } = await import("./lib/draft-recovery-fixtures.mjs");
      await prepareDraftRecoveryFixtures(page, ctx);
    }
    await mod.run(page, shot, ctx);
    console.log(attempt > 1 ? `  RETRIED-PASS (attempt ${attempt})` : `  PASS`);
  } catch (err) {
    ok = false;
    error = err;
    console.error(`  FAIL [${classifyFailure(err, netFailures)}]: ${err?.stack ?? err}`);
    if (netFailures.length > 0) {
      const failedAt = Date.now();
      console.error(`  ${netFailures.length} request(s) got no response during this attempt ` +
        `(${((failedAt - flowStarted) / 1000).toFixed(0)}s long) — the network-level evidence, ` +
        `each with how long BEFORE the failure it happened:`);
      for (const f of netFailures.slice(0, 5)) {
        console.error(`    -${((failedAt - f.at) / 1000).toFixed(1)}s  ${f.line}`);
      }
      if (netFailures.length > 5) console.error(`    ... and ${netFailures.length - 5} more`);
      if (netFailures.some((f) => f.line.includes("net::ERR_NETWORK_CHANGED"))) console.error(NETWORK_CHANGED_HINT);
    }
    await shot("failure").catch(() => {});
  } finally {
    const video = page.video();
    await context.close().then(() => { contextClosed = true; }).catch((closeErr) => {
      console.error(`  (error closing browser context: ${closeErr})`);
    });
    if (video) {
      try {
        const videoPath = await video.path();
        await rename(videoPath, path.join(flowDir, "video.webm"));
      } catch (renameErr) {
        console.error(`  (could not finalize video: ${renameErr})`);
      }
    }
  }
  return {
    ok,
    contextClosed,
    error,
    kind: ok ? null : classifyFailure(error, netFailures),
    // The dev-DB writes this attempt is known to have made, plus the ones whose outcome it cannot
    // know. The out-of-band counters (ctx.lockRevision, ctx.apiMutate — neither visible to the
    // context events above) are folded in here rather than tracked as separate concepts
    // downstream.
    committed: committed + (state.outOfBand.committed - outOfBandBefore.committed),
    indeterminate: (attempted - answered) + (state.outOfBand.indeterminate - outOfBandBefore.indeterminate),
    netFailures,
  };
}

async function main() {
  const results = [];
  // Shared by both isPortFree refusals below (#326 fix round 2): the message names the same
  // remedy either way, so the two checks read as one guard with two trigger points, not two
  // independently-worded ones that could drift.
  const portInUseError = () => new Error(
    `Port ${PORT} is already in use — an orphaned dev server from a previous run (a Ctrl-C ` +
    `before this harness handled signals?), or ANOTHER E2E RUN IN PROGRESS. Check for a live ` +
    `\`node e2e/run.mjs\` before assuming it is orphaned (\`lsof -i:${PORT}\`): killing the ` +
    `port out from under a running suite reds every remaining flow with ERR_CONNECTION_REFUSED ` +
    `and is indistinguishable from a product failure. If it really is orphaned, ` +
    `\`fuser -k ${PORT}/tcp\` and re-run.`,
  );

  try {
    // FIRST, before touching anything on disk. A second harness process refused here must leave a
    // RUNNING one completely undisturbed — and it did not: the artifacts rotation below used to
    // happen first, so a refused run renamed a live run's artifacts directory out from under it
    // (the running harness's open dev-server.log fd followed the inode into `-prev`, and its
    // screenshots kept landing in the renamed directory). Observed for real, 2026-08-22, when two
    // runs overlapped on this machine. Before the fix-round rotation it was worse still: the
    // refused run `rm -rf`'d the live one's screenshots outright.
    if (!(await isPortFree(PORT))) throw portInUseError();

    // Before anything expensive: refuse a flow that mutates where the retry gate cannot see it.
    const sourceCount = await assertNoRawApiMutations();
    console.log(`Checked ${sourceCount} suite source file(s) (flows + lib) for uncounted APIRequestContext\n  mutations, ambient board-row locators, unchecked absence assertions and plain-Error throws: none`);

    // #335: setup reads the cancellation latch between its steps, as the flow loop does between
    // flows. Each check returns from inside this `try`, so the `finally` still joins the teardown
    // the signal handler started. This one keeps a run cancelled during the two awaits above from
    // paying for the pre-flight and the build.
    if (state.cancelled) return;

    // #167a: the dev database's own ambient state, read BEFORE a single fixture row is written —
    // so everything the check sees belongs to somebody else, which is precisely the population
    // close-month-end refuses to touch. See e2e/lib/preflight.mjs for the four conditions (plus the
    // fifth reason that is not a condition — the close service refusing to report at all), why they
    // are the only ones, and why "before flow 1" is the correct moment to evaluate them rather than
    // merely the convenient one. That file is the authority; do not re-enumerate them here.
    const ambient = runDbScript("preflight");
    const ambientRefusal = preflightRefusal(ambient);
    if (ambientRefusal) throw new Error(`Refusing to run the flows: ${ambientRefusal}`);
    console.log(`Dev DB pre-flight for ${ambient.year}-${String(ambient.month).padStart(2, "0")}: ` +
      `no close period, ${ambient.unpostedBatchCount} unposted batch(es), variance ${ambient.variance}, ` +
      `${ambient.readinessGaps.length} ambient readiness gap(s)`);

    // #335: the pre-flight above blocks the event loop, and nothing yields between it and what
    // follows, so a signal sent to this process alone during it would only be read after the whole
    // build (production) or at the rotation's first await (dev), too late to keep the one kept
    // generation of artifacts. Yield first, in both modes. TWO turns, by measurement on the Node in
    // .nvmrc (a blocking child, SIGTERM to the parent alone): after one setImmediate turn the
    // handler had not run in any trial, after two it had in every one. Signals are read in the
    // loop's poll phase, and only the second turn has a whole poll phase behind it.
    for (let turn = 0; turn < 2; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    if (state.cancelled) return;

    if (SERVER_MODE === "production") {
      console.log("Building the production server (next build + standalone tree)...");
      state.preparing = prepareProductionServer();
      await state.preparing;
    }

    // #335: directly after the preparation, ahead of the port re-check (which would refuse a
    // cancelled run as "port in use") and of the rotation below (a cancelled run has no evidence
    // to keep, so it must not spend the one kept generation). Outside the production branch, so
    // it is dev mode's check before the rotation too.
    if (state.cancelled) return;

    if (SERVER_MODE === "production") {
      // #326 fix round 2: `next build` runs for tens of seconds to a couple of minutes, so the
      // FIRST isPortFree check above (taken before the build started) is stale by the time we get
      // here. The standalone server.js has no port fallback the way `next dev` does — on
      // EADDRINUSE it exits — so a run that raced another process onto PORT during the build would
      // otherwise fall through to waitForServer polling and possibly succeed against THAT OTHER
      // run's server, reporting flows as passing against state this run never touched. Re-check
      // now, before the artifacts rotation commits this run to proceeding.
      if (!(await isPortFree(PORT))) throw portInUseError();
    }

    // Only now (besides the production build just above, which the refusals ahead of it exist to
    // avoid paying for) is anything else on disk touched. #184 fix (b) keeps ONE generation of the
    // previous run's artifacts by ROTATING rather than deleting them — wiping destroyed dev-server.log and
    // the failing screenshots at the start of the very next run, i.e. the moment anyone did the
    // thing #184 documents people doing, re-running to see whether it clears. That guarantee is
    // exactly one generation deep, so it has to survive a REFUSAL: with the rotation above the two
    // cheap refusals, two consecutive refused runs (a raw mutation, or a dev DB carrying the
    // demonstration dataset — both of which a developer hits repeatedly while fixing them) pushed a
    // real failing run's evidence out of `-prev` and into nothing, having produced no evidence of
    // their own to replace it. The port check, the flow-lint sweep and the dev-DB pre-flight are
    // all pure reads; none of them needs a directory. The current run still gets the stable
    // `e2e-artifacts/<flow>/` paths the docs and the issue both name.
    await rm(PREV_ARTIFACTS_DIR, { recursive: true, force: true });
    let rotated = false;
    try {
      await rename(ARTIFACTS_DIR, PREV_ARTIFACTS_DIR);
      rotated = true;
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;   // no previous run to keep
    }
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    if (rotated) console.log(`Previous run's artifacts kept at ${PREV_ARTIFACTS_DIR}`);
    // #588: the share, pre-cleaned like the backup folder, with the marker file the server reads as
    // "the share is connected". Before the backup folder, so that folder's mkdir stays the last
    // await ahead of the check below (#335; tests/e2e-cancellation.test.ts pins the order).
    await rm(OFFICE_SHARE_DIR, { recursive: true, force: true });
    await mkdir(OFFICE_SHARE_DIR, { recursive: true });
    await writeFile(path.join(OFFICE_SHARE_DIR, CUSTOMER_FOLDERS_MARKER),
      "Written by the E2E harness (e2e/run.mjs); removed with this folder at teardown.\n");
    await rm(BACKUP_DIR, { recursive: true, force: true });
    await mkdir(BACKUP_DIR, { recursive: true });

    // #335: nothing yields between this check, the fixture CLI and the server start. A teardown
    // that began during the awaits above found no fixtures and no server and may have finished
    // already; creating either now would leave rows in the dev DB and a detached server behind.
    if (state.cancelled) return;
    console.log("Creating dev-DB fixtures (erp)...");
    state.fixtures = runDbScript("create");
    console.log(`  customer ${state.fixtures.customerCode}, part ${state.fixtures.partNumber}, ` +
      `step codes ${state.fixtures.stepCodeA.code}/${state.fixtures.stepCodeB.code}, ` +
      `users ${state.fixtures.adminUsername}/${state.fixtures.restrictedUsername}`);

    console.log(`Starting the ${SERVER_MODE} server on port ${PORT}...`);
    state.devServer = startServer();
    try {
      await waitForServer(`${BASE_URL}/login`, 60000, state.devServer);
    } catch (err) {
      console.error(`--- ${SERVER_MODE} server output ---\n${state.devServer.getOutput()}\n-----------------------`);
      throw err;
    }
    console.log("  dev server is up");

    // #184 fix (a). `waitForServer` above compiled exactly ONE route (`/login`); everything else
    // used to compile on its first hit inside a flow, under whatever load the machine still
    // carried. See e2e/lib/warmup.mjs for how the route set is derived (from the filesystem,
    // never a hand-list) and why every request is a cookie-less GET.
    console.log("Warming every route so no flow pays for a cold compile...");
    const memory = devServerMemoryMeter(state.devServer);
    const warm = await warmRoutes(BASE_URL, APP_DIR, { log: (line) => console.log(line) });
    const devPeakMb = memory.stop();
    // Report what the warm-up COST in memory, because that is how the next regression gets caught
    // early instead of by an OOM kill. Reported, deliberately NOT enforced: the number is
    // legitimately large (the compile is genuinely expensive), it varies with the machine, and a
    // threshold picked today would either fire on honest runs or sit too high to mean anything.
    // A line in the log a reviewer can compare across runs is the useful artifact.
    //
    // PRINTED BEFORE THE REFUSAL BELOW, deliberately. A warm-up that blows its budget or fails
    // most of its requests is the likeliest shape of a memory problem — the dev server thrashing,
    // stalling or being OOM-killed — so throwing first would withhold this number in exactly the
    // runs that need it. The refusal points at dev-server.log, which carries the CHILD's output
    // and never this harness-side measurement, so it is no substitute.
    //
    // This exists because a real regression hid behind exactly this blind spot: a Next bump made
    // every API route cost hundreds of MB where the previous version cost single digits, and it
    // presented as a killed CI runner and two dead desktop sessions, none of which named memory
    // as the cause. HANDOFF §4 (2026-09-04) carries the measurements.
    if (devPeakMb) console.log(`  dev server peak RSS through warm-up: ${devPeakMb} MB`);

    // The warm-up's failure signal used to be computed and thrown away: a dev server that died
    // right after `waitForServer` produced 243 "not fatal" lines and then 25 flow failures with no
    // named cause. A handful of slow routes is still not fatal — see warmupRefusal for the shapes
    // that are.
    const warmRefusal = warmupRefusal(warm);
    if (warmRefusal) throw new Error(`Refusing to run the flows: ${warmRefusal}. See ${DEV_SERVER_LOG}.`);

    // handleSIGINT/handleSIGTERM default to true — Playwright would otherwise install its OWN
    // signal handlers that close the browser (and exit) on Ctrl-C, racing installSignalHandlers()
    // above: whichever handler's process.exit() lands first wins, and Playwright's has no idea
    // the dev server needs killing or the dev-DB fixtures need cleaning up first. Disabling both
    // hands exclusive control of the shutdown sequence to teardown() above, in the order it
    // chooses (dev server, then fixtures, then browser).
    state.browser = await chromium.launch({
      headless: !HEADED,
      handleSIGINT: false,
      handleSIGTERM: false,
      // #348: resolves the insecure-origin flow's non-loopback host to this run's own server, so
      // one flow can browse a real insecure context. It maps only that one name, so every other
      // flow's `localhost` resolves exactly as before (e2e/lib/insecure-origin.mjs).
      args: [`--host-resolver-rules=${HOST_RESOLVER_RULE}`],
      // ...and keeps a proxy from receiving that name first: in the CI runner the browser reads
      // the job's proxy variables, and the proxy refuses the mapped host (browserEnv's header).
      env: browserEnv(process.env),
      ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}),
    });

    const ctx = {
      baseURL: BASE_URL,
      serverMode: SERVER_MODE,
      fixtures: state.fixtures,
      created: state.created,
      lockRevision: (partId, revisionNumber) => {
        // Counted (see state.outOfBand): this is a dev-DB write the browser never sees, so the
        // retry decision would otherwise believe the flow had changed nothing. Counted BEFORE the
        // call, so a throw mid-write still counts — the safe direction.
        state.outOfBand.committed += 1;
        return runDbScript("lock-revision", { partId, revisionNumber });
      },
      // The counted way to write outside the page; its contract and idempotent retry live in
      // e2e/api-mutate.mjs (#321).
      apiMutate: makeApiMutate(state.outOfBand),
      // #588: the share the server was handed (startServer), so a flow builds its folders and its
      // pasted paths from the same two values and never retypes them.
      officeShare: { dir: OFFICE_SHARE_DIR, root: OFFICE_SHARE_ROOT },
      // Release updates: the folder the server was handed, and the counted dev-DB reset of the
      // hold row and the flow users' last-seen version (the lockRevision shape).
      updatesDir: UPDATES_DIR,
      resetUpdates: () => {
        state.outOfBand.committed += 1;
        return runDbScript("reset-updates");
      },
    };

    // Deliberately sequential, not Promise.all: every flow after the first depends on state an
    // earlier one left in the dev DB (the values typed-fields saves, the revision revision-cut
    // cuts).
    for (const flow of activeFlows) {
      if (state.cancelled) break;
      const recovery = flow.name === "draft-recovery";
      if (recovery) {
        // Register the ownership boundary before dispatch. Exact-name fallback also covers a
        // transaction committed without a captured stdout result; no other created slot changes.
        state.created.draftRecovery = { phase: "creating", ids: [] };
        state.outOfBand.indeterminate += 1;
        ctx.fixtures.draftRecoverySeed = runDbScript("create-draft-recovery");
        state.outOfBand.indeterminate -= 1;
        state.outOfBand.committed += 1;
        state.created.draftRecovery.phase = "seeded";
      }
      let recoverySafeToReap = false;
      try {
        let result = await runFlow(state.browser, flow, ctx, 1);
        let retried = false;
        if (!result.ok && !state.cancelled) {
          // An unclosed first recovery context cannot be erased by a later attempt's result.
          const refusal = recovery && !result.contextClosed
            ? "Recovery context did not close — refusing retry and requiring owned-server shutdown"
            : retryRefusal(result);
          if (refusal) {
            console.error(`  ${refusal}`);
          } else {
            console.error(`  network-level failure with nothing committed — retrying once`);
            retried = true;
            result = await runFlow(state.browser, flow, ctx, 2);
          }
        }
        recoverySafeToReap = result.contextClosed && result.indeterminate === 0;
        results.push({ name: flow.name, retried, ...result });
      } finally {
        // Cancellation owns shared teardown; a late result must neither reap nor reset its metadata.
        if (recovery && !state.cancelled) {
          // Browser closure alone cannot join an unanswered server write. Such an attempt
          // aborts the suite here: shared teardown stops the owned server before DB reaping.
          assert.equal(recoverySafeToReap, true, "Recovery cleanup needs owned-server shutdown before reaping indeterminate writes or an unclosed context");
          // With acknowledged writes and a closed context, this is the accounting barrier.
          // A reap failure also aborts before close-month-end and reaches shared teardown.
          state.outOfBand.indeterminate += 1;
          const reaped = runDbScript("reap-draft-recovery");
          assert.equal(reaped.ok, true, "Recovery fixtures must be reaped before month-end");
          state.outOfBand.indeterminate -= 1;
          state.outOfBand.committed += 1;
          state.created.draftRecovery.phase = "cleaned";
          delete ctx.fixtures.draftRecovery;
          delete ctx.fixtures.draftRecoverySeed;
        }
      }
    }
  } finally {
    await teardown();
  }

  // The signal handler owns the nonzero exit; a late successful attempt is not a green suite.
  if (state.cancelled) return;

  console.log("\n=== Results ===");
  for (const r of results) {
    // A retried flow NEVER prints as a plain PASS — the point of the classification is that a run
    // that needed a retry and a run that did not are visibly different afterwards. The line shape
    // (verdict token + spacing) is resultsLine's, pinned in tests/e2e-harness.test.ts against the
    // `^  RETRIED ` grep the CI retry gate runs (#190).
    console.log(resultsLine(r));
  }
  const failed = results.filter((r) => !r.ok);
  const retriedOk = results.filter((r) => r.ok && r.retried);
  if (retriedOk.length > 0) {
    console.warn(`\n${retriedOk.length} flow(s) only passed on a retry after a network-level ` +
      `failure: ${retriedOk.map((r) => r.name).join(", ")}. The run is green, but the dev server ` +
      `dropped a request — see ${DEV_SERVER_LOG} and the __attempt-2 artifact directories.`);
  }
  if (failed.length > 0 || results.length !== activeFlows.length) {
    console.error(`\n${failed.length} of ${activeFlows.length} flow(s) failed.`);
    process.exitCode = 1;
  } else if (state.cleanupFailed) {
    console.error(`\nAll ${activeFlows.length} flows passed, but dev-DB cleanup FAILED — fixture rows ` +
      `are still in the erp database and the next run's self-heal will have to reap them. ` +
      `Treating the run as failed: ${state.cleanupFailed}`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${activeFlows.length} flows passed. Artifacts: ${ARTIFACTS_DIR}`);
  }
}

installSignalHandlers();
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
