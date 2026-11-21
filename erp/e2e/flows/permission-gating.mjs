// Flow 5: the fixture restricted user (parts.view + processes.view only, no processes.edit) — a
// second, deliberately underprivileged login, per spec §12 — opens the fixture part. The
// designer must render fully (view is granted) but every mutating control must be disabled, each
// with a tooltip naming the permission that would unlock it (processes.edit), never just silently
// missing.
//
// Fix-wave 1 (Task 5 review, finding 8) adds a second section: the Pricing section's double gate
// (parts.edit AND action.change_prices, PricingSection.tsx) — the one place on this page two
// permissions AND together rather than a single gate deciding everything, and, before this,
// something no automated check anywhere in the suite ever touched. Case 1 (still the restricted
// user, holding neither) shows the parts.edit title wins the tie-break — the same shape every
// other gate in this flow already proves. Case 2 re-logs-in (the credit-hold-block-and-override.
// mjs precedent) as a purpose-built fixture user who HAS parts.edit but not change_prices, and
// shows the SECOND gate bite once the first is satisfied — the part of this screen a single-gate
// section can never demonstrate.
import assert from "node:assert/strict";
import { assertNeverVisible, processRow, processSection } from "../lib/ui.mjs";
import { login } from "../lib/auth.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { glanceValue } from "../lib/invoicing.mjs";

const REQUIRES_EDIT = "Requires processes.edit";
const REQUIRES_PARTS_EDIT = "Requires parts.edit";
const REQUIRES_CHANGE_PRICES = "Requires change_prices";

async function assertDisabledWithTooltip(locator, label, expectedTitle = REQUIRES_EDIT) {
  assert.equal(await locator.isDisabled(), true, `${label} should be disabled`);
  assert.equal(await locator.getAttribute("title"), expectedTitle, `${label} tooltip should read "${expectedTitle}"`);
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const { stepCodeA } = fixtures;

  await page.goto(`${ctx.baseURL}/parts/${fixtures.partId}`);
  await openRecordTab(page, "Process recipe");
  const section = processSection(page);
  await section.waitFor({ state: "visible" });
  const step = processRow(page, stepCodeA.code);
  await step.waitFor({ state: "visible" });
  // A restricted-but-still-view-holding user sees the real table, not the section's
  // processes.view placeholder — this is the disabled-with-a-reason path, not the denied one.
  await assertNeverVisible(
    section.getByText("Process steps need processes.view access.", { exact: true }),
    "view-denied placeholder should not render for a user who holds processes.view",
    1000,
  );
  await shot("part-designer-visible-to-restricted-user");

  // The row's own controls (spec 2026-09-26 §4): the instruction, the typed parameter values, the
  // drag handle, the ⋮ menu and both edge chips. Exact names: a value input's unit input and ✕
  // button carry longer names that also contain the parameter's label.
  await assertDisabledWithTooltip(step.getByPlaceholder("Instruction"), "step instruction textarea");
  await assertDisabledWithTooltip(step.getByLabel("Step 1 Temperature", { exact: true }), "Temperature field");
  await assertDisabledWithTooltip(step.getByLabel("Step 1 Passed", { exact: true }), "Passed checkbox");
  await assertDisabledWithTooltip(step.getByRole("button", { name: "Move step 1", exact: true }), "Reorder handle");
  await assertDisabledWithTooltip(step.getByRole("button", { name: "Step 1 actions", exact: true }), "Step actions menu");
  await assertDisabledWithTooltip(step.getByRole("button", { name: "Insert a step above step 1", exact: true }), "+ Insert chip");
  await assertDisabledWithTooltip(step.getByRole("button", { name: "Add a parameter to step 1", exact: true }), "+ Parameter chip");
  // The section's own: the add-step search, Discard process changes and the save.
  await assertDisabledWithTooltip(section.getByRole("combobox", { name: "Add a step — search code or name", exact: true }), "Add step search");
  await assertDisabledWithTooltip(section.getByRole("button", { name: "Discard process changes", exact: true }), "Discard process changes button");
  await assertDisabledWithTooltip(section.getByRole("button", { name: "Save process steps" }), "Save step button");

  await shot("mutating-controls-disabled-with-tooltips");
  // PR 9: the card's revision row is the current revision, for a caller who holds processes.view.
  await glanceValue(page, "Recipe revision").waitFor({ state: "visible" });
  assert.match(await glanceValue(page, "Recipe revision").innerText(), /^\d+$/);

  // --- Pricing section, Case 1: still the restricted user (neither parts.edit nor
  // change_prices). "Price per" and "Remove operation price" are picked deliberately: both are
  // `disabled={disabled}` alone in PricingSection.tsx, with no other condition (unlike the
  // money inputs, which are `readOnly` not `disabled`, or the step-code select, which also
  // depends on the options fetch having settled) — so a `true` here can only be the permission
  // gate, never a confound. ---
  await openRecordTab(page, "Pricing & quotes");
  const pricingSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Operation prices" }) });
  await pricingSection.waitFor({ state: "visible" });
  await assertDisabledWithTooltip(pricingSection.getByLabel("Price per"), "Price per select", REQUIRES_PARTS_EDIT);
  await assertDisabledWithTooltip(
    pricingSection.getByRole("button", { name: "Remove operation price" }), "Remove operation price button", REQUIRES_PARTS_EDIT);
  await shot("pricing-disabled-for-restricted-user");

  // --- Pricing section, Case 2: re-logged-in as the fixture price editor (parts.view +
  // parts.edit, deliberately NOT action.change_prices). The FIRST gate is now satisfied, so the
  // title has to come from the second one — the double-AND this screen is built around. ---
  await login(page, ctx.baseURL, fixtures.priceEditUsername, fixtures.priceEditPassword);
  await page.goto(`${ctx.baseURL}/parts/${fixtures.partId}`);
  await openRecordTab(page, "Pricing & quotes");
  const pricingSectionAsEditor = page.locator("section").filter({ has: page.getByRole("heading", { name: "Operation prices" }) });
  await pricingSectionAsEditor.waitFor({ state: "visible" });
  await assertDisabledWithTooltip(
    pricingSectionAsEditor.getByLabel("Price per"), "Price per select", REQUIRES_CHANGE_PRICES);
  await assertDisabledWithTooltip(
    pricingSectionAsEditor.getByRole("button", { name: "Remove operation price" }), "Remove operation price button",
    REQUIRES_CHANGE_PRICES);
  await shot("pricing-requires-change-prices-with-parts-edit-held");
}
