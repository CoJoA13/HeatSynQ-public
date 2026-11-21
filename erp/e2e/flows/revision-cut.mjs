// Flow 3: THE revision-cut rule (spec §5) made visible. Locks the fixture part's revision 1 —
// standing in for Phase 3's order save, via ctx.lockRevision (db-fixtures.ts's lock-revision
// command, which calls the real, audited part-process-steps.ts lockRevision service function) —
// then edits a step on that now-locked current revision. Editing a locked current revision
// silently cuts a new one (§5.4): the UI must show "Rev 2 · working", and switching back to
// Rev 1 must show it read-only and untouched by the edit.
import assert from "node:assert/strict";
import { processRow, processSection, waitForValue, waitForChecked, fillReliable } from "../lib/ui.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";

const MIDDOT = "·";
// The fixture part's first step as the fixture setup (db-fixtures.ts's create) writes it.
const ORIGINAL_INSTRUCTION = "Heat to target temperature and hold.";
const EDITED_INSTRUCTION = "Heat to target temperature and hold. Then air cool (rev2 edit).";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const { stepCodeA } = fixtures;

  const lockResult = ctx.lockRevision(fixtures.partId, 1);
  assert.equal(lockResult.ok, true, "lockRevision fixture call did not report ok");

  await page.goto(`${ctx.baseURL}/parts/${fixtures.partId}`);
  await openRecordTab(page, "Process recipe");
  const section = processSection(page);
  await section.getByText(`Rev 1 ${MIDDOT} locked`).waitFor({ state: "visible" });
  // Owner answer D-3: a locked current revision always says a save cuts the next one. The lock here
  // stands in for an order without creating one, so no order keeps Rev 1 and the note is the bare form.
  await section.getByText("Saving creates Rev 2.", { exact: true }).waitFor({ state: "visible" });
  await shot("rev1-locked-current");

  const step = processRow(page, stepCodeA.code);
  // Settle the initial page load first (confirms no pending drafts-rebuild effect from THIS
  // navigation remains — the read-side race waitForValue guards against), then fillReliable for
  // the edit itself (the write-side twin — ui.mjs's doc comment).
  await waitForValue(step.getByPlaceholder("Instruction"), ORIGINAL_INSTRUCTION);
  await fillReliable(step.getByPlaceholder("Instruction"), EDITED_INSTRUCTION);
  await section.getByRole("button", { name: "Save process steps" }).click();

  // The PUT /process/document response carries revision 2 (a cut just happened), which
  // ProcessStepsSection.tsx's refreshAfter treats as "switch the picker to it".
  await section.getByText(`Rev 2 ${MIDDOT} working`).waitFor({ state: "visible", timeout: 10000 });
  const cutStep = processRow(page, stepCodeA.code);
  // waitForValue, not a bare inputValue() snapshot — see ui.mjs's doc comment: the row can
  // render a tick before its values land.
  await waitForValue(cutStep.getByPlaceholder("Instruction"), EDITED_INSTRUCTION);
  await shot("rev2-working-after-cut");

  // Switch the picker back to the now-superseded Rev 1.
  const revisionSelect = section.getByLabel("Process revision", { exact: true });
  await revisionSelect.selectOption("1");
  await section.getByText(`Rev 1 ${MIDDOT} locked`).waitFor({ state: "visible" });
  await section.getByText("Rev 1 is superseded and read-only.", { exact: true }).waitFor({ state: "visible" });

  const historicalStep = processRow(page, stepCodeA.code);
  const historicalInstruction = historicalStep.getByPlaceholder("Instruction");
  await waitForValue(historicalInstruction, ORIGINAL_INSTRUCTION);
  await waitForValue(historicalStep.getByLabel("Step 1 Temperature", { exact: true }), "1550");
  await waitForChecked(historicalStep.getByLabel("Step 1 Passed", { exact: true }), true);
  // disabled/title come from the same render pass as the value above (no separate effect), so
  // once the value has settled these are safe to read directly.
  assert.equal(await historicalInstruction.isDisabled(), true, "Rev 1 fields should be read-only");
  assert.equal(await historicalInstruction.getAttribute("title"), "Superseded revision — read-only");
  await shot("rev1-readonly-unchanged");
}
