// Flow 2: fill a NUMBER field and a CHECKBOX field on the E2E-QNCH step the fixture setup
// (db-fixtures.ts's create) puts on the fixture part's working revision, save, reload the page, and
// confirm both values render back in their typed inputs — not just persisted server-side.
import { processRow, processSection, waitForValue, waitForChecked, fillReliable, checkReliable, waitForProcessSaveSettled } from "../lib/ui.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const { stepCodeA } = fixtures;

  await page.goto(`${ctx.baseURL}/parts/${fixtures.partId}`);
  await openRecordTab(page, "Process recipe");
  const section = processSection(page);
  // The Process Steps table's row for the heat step (its Step column prints the code).
  const step = processRow(page, stepCodeA.code);
  await step.waitFor({ state: "visible" });
  await shot("before-fill");

  // Exact names: the value input is "Step 1 Temperature", and its unit input and ✕ button carry
  // longer names that also contain "Temperature".
  const temperature = step.getByLabel("Step 1 Temperature", { exact: true });
  const passed = step.getByLabel("Step 1 Passed", { exact: true });
  // waitForValue/waitForChecked, not bare snapshots — the row can render a tick before its
  // values land (ui.mjs's doc comment).
  await waitForValue(temperature, "");
  await waitForChecked(passed, false);

  // fillReliable/checkReliable, not bare fill()/check() — see ui.mjs's doc comment: a delayed
  // effect from this same page's own detail-load can still be scheduled and clobber a value typed
  // right after the field first appears.
  await fillReliable(temperature, "1550");
  await checkReliable(passed, true);
  await shot("filled-before-save");

  const saveButton = section.getByRole("button", { name: "Save process steps" });
  await saveButton.click();
  // Save round-trips through refreshAfter (reload revisions + detail), which resets the local
  // draft to server truth and flips isDirty back to false — the button disabling itself is a
  // cleaner "the PUT /process/document landed" signal than a fixed sleep.
  await waitForProcessSaveSettled(page);
  await shot("saved");

  await page.reload();
  const reloadedStep = processRow(page, stepCodeA.code);
  await reloadedStep.waitFor({ state: "visible" });

  await waitForValue(reloadedStep.getByLabel("Step 1 Temperature", { exact: true }), "1550");
  await waitForChecked(reloadedStep.getByLabel("Step 1 Passed", { exact: true }), true);
  await shot("persisted-after-reload");
}
