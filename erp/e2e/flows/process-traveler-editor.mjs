// The part page's Process Steps table and its traveler preview dialog (spec 2026-09-26 §4–§5),
// driven end to end on the process suite's own part, E2E-PART-1, which typed-fields and
// revision-cut leave on a working revision with a heat step (E2E-QNCH, suggesting Temperature and
// Passed) and a wash step (E2E-WASH, suggesting nothing).
//
// The order is deliberate. Every edit is made and saved on the working revision first; a real order
// then locks it; the preview dialog is exercised around that order; a save cuts the next revision.
// A second fictional part with no orders (the order suite's rider part) shows the SAMPLE header,
// the restricted user reads everything disabled, and the Undo window runs LAST under Playwright's
// clock, which is installed for the whole browser context and cannot be removed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { login } from "../lib/auth.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { assertNeverVisible, fillReliable, pickCombobox, pickProcessCode, processRows, processSection, waitForFocused, waitForValue, waitForProcessSaveSettled } from "../lib/ui.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

const section = processSection;
const rows = processRows;
const defaultText = "Heat to target.\n\nTime in: ________";
const secondDefaultText = "Wash until clean.\n\nInspector: ________";
const changedDefault = "Changed after the part copied it";
const SEARCH = "Add a step — search code or name";
const REQUIRES_EDIT = "Requires processes.edit";
const button = (page, name) => section(page).getByRole("button", { name, exact: true });
const labelled = (page, name) => section(page).getByLabel(name, { exact: true });
const dialogOf = page => page.getByRole("dialog", { name: "Traveler preview" });
// A suggested row copied onto a new step, before anything is typed into it.
const emptyTemperature = { name: "Temperature", value: "", unit: "°F", blank: true };
const emptyPassed = { name: "Passed", value: "", unit: "", blank: true };

/** The table as the operator reads it, row by row: identity, code, instruction and each parameter
 *  line (`blank` is the amber outline an empty value carries). A checkbox's stored `""` and
 *  `"false"` look alike unchecked, so the outline tells them apart. */
async function table(page) {
  return rows(page).evaluateAll(trs => trs.map(tr => ({
    id: tr.dataset.stepId ?? "",
    code: tr.cells[2]?.querySelectorAll("div")[1]?.textContent ?? "",
    instruction: tr.querySelector("textarea")?.value ?? null,
    parameters: [...(tr.cells[3]?.querySelectorAll(":scope > div") ?? [])].map(line => {
      const [name, value, unit] = line.querySelectorAll("input");
      const blank = value.classList.contains("ring-accent-400");
      return { name: name.value, value: value.type === "checkbox" ? (value.checked ? "true" : blank ? "" : "false") : value.value, unit: unit.value, blank };
    }),
  })));
}
const ids = async page => (await table(page)).map(row => row.id);
const withoutIds = state => state.map(({ code, instruction, parameters }) => ({ code, instruction, parameters }));

async function save(page) {
  await button(page, "Save process steps").click();
  await waitForProcessSaveSettled(page);
}
/** ⋮ on step `n`, then one of its menu items. */
async function menuAction(page, n, item) {
  await button(page, `Step ${n} actions`).click();
  await section(page).getByRole("menu", { name: `Step ${n} actions`, exact: true }).getByRole("menuitem", { name: item, exact: true }).click();
}
async function bounded(promise, label) {
  let timer;
  try { const result = await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), 15000); })]); assert.ok(result, label); return result; }
  finally { clearTimeout(timer); }
}
async function until(read, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!read()) {
    if (Date.now() > deadline) assert.fail(`Timed out: ${label}`);
    await new Promise(resolve => { setTimeout(resolve, 50); });
  }
}
async function waitForText(locator, pattern, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await locator.textContent({ timeout: 1000 }).catch(() => null);
    if (pattern.test(last ?? "")) return;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}: last saw ${JSON.stringify(last)}`);
    await new Promise(resolve => { setTimeout(resolve, 50); });
  }
}
/**
 * A native drag by the handle named `from`, released on the handle named `to` (a row's centre may be
 * an editable textarea, so the gesture ends on the target row's handle). Every drag event is recorded
 * with the row it hit. `beforeRelease` is the trace as it stood just before the release (and before
 * Escape, with `cancel`); `trace` is the whole gesture. The gesture starts before the destination is
 * scrolled into view, as a user's does.
 */
async function dragHandle(page, from, to, { cancel = false } = {}) {
  await page.evaluate(() => {
    const events = [];
    const record = event => {
      events.push({ type: event.type, step: event.target.closest?.("tr[data-step-id]")?.dataset.stepId ?? null });
      if (events.length > 60) events.shift();
    };
    window.__processDragTrace = { events, record };
    for (const name of ["dragstart", "dragover", "drop", "dragend"]) document.addEventListener(name, record, true);
  });
  let beforeRelease = [], trace = [];
  try {
    const source = button(page, from), target = button(page, to);
    // Centred, never "if needed": the section's sticky header covers the viewport's top, and a
    // handle left under it takes neither the press nor the drop (the part page's tabs made the page
    // short enough to land there, PR 9).
    await source.evaluate(el => el.scrollIntoView({ block: "center" }));
    const start = await source.boundingBox(); assert.ok(start);
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2 + 12, { steps: 6 });
    await page.waitForFunction(() => window.__processDragTrace.events.some(event => event.type === "dragstart"), undefined, { timeout: 3000 });
    await target.evaluate(el => el.scrollIntoView({ block: "center" }));
    const end = await target.boundingBox(); assert.ok(end);
    const x = end.x + end.width / 2, y = end.y + end.height / 2;
    await page.mouse.move(x, y, { steps: 12 });
    await page.mouse.move(x + 1, y + 1);
    beforeRelease = await page.evaluate(() => [...window.__processDragTrace.events]);
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
  } finally {
    await page.mouse.up();
    trace = await page.evaluate(() => {
      const recorded = window.__processDragTrace;
      for (const name of ["dragstart", "dragover", "drop", "dragend"]) document.removeEventListener(name, recorded.record, true);
      delete window.__processDragTrace;
      return recorded.events;
    });
    console.log(`Process pointer gesture${cancel ? " (cancelled with Esc)" : ""}:`, JSON.stringify(trace));
  }
  return { beforeRelease, trace };
}
/** A disabled row's edge chips stay hidden until the row is hovered, then show greyed with their
 *  reason (owner ruling 2026-09-27). Computed opacity, because Playwright counts a transparent
 *  element as visible. */
async function assertDisabledChipsRevealOnHover(page, rowIndex, reason) {
  const n = rowIndex + 1;
  const chips = [`Insert a step above step ${n}`, `Add a parameter to step ${n}`];
  const opacity = name => button(page, name).evaluate(element => getComputedStyle(element).opacity);
  await page.mouse.move(0, 0);
  for (const name of chips) {
    assert.equal(await button(page, name).isDisabled(), true, `${name} is disabled`);
    assert.equal(await opacity(name), "0", `${name} stays hidden until its row is hovered`);
  }
  await rows(page).nth(rowIndex).hover();
  for (const name of chips) {
    assert.equal(await opacity(name), "1", `${name} shows when its row is hovered`);
    assert.equal(await button(page, name).getAttribute("title"), reason, `${name} gives its reason`);
  }
  await page.mouse.move(0, 0);
}
/** The greyed EQ# · OP · Date cue's cells (header and rows), by their computed display. */
const cueDisplays = page => section(page).locator('#process-steps-table [aria-hidden="true"]')
  .evaluateAll(cells => [...new Set(cells.map(cell => getComputedStyle(cell).display))]);
/** Names what makes a page wider than its viewport, for a failure message. The column beside the
 *  navigation rail is a flex item, which cannot shrink below its content, so one over-wide box
 *  anywhere below it widens the whole page. Let the column shrink for one measurement, list the
 *  boxes that then stick out of their parents (with each parent), and put the layout back.
 *  Diagnostic only: it runs when the page already scrolls sideways. */
async function overflowCulprits(page) {
  const found = await page.evaluate(() => {
    const describe = el => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 5).join(".")}` : ""}` +
      ` "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50)}"`;
    const column = document.querySelector("main")?.parentElement;
    const before = column?.style.minWidth ?? "";
    if (column) column.style.minWidth = "0";
    const out = [];
    try {
      for (const el of document.body.querySelectorAll("*")) {
        const parent = el.parentElement; const box = el.getBoundingClientRect();
        if (!parent || (box.width === 0 && box.height === 0)) continue;
        const outer = parent.getBoundingClientRect();
        if (box.right > outer.right + 1) out.push(`${describe(el)} right ${Math.round(box.right)} > parent ${describe(parent)} right ${Math.round(outer.right)}`);
        if (out.length >= 12) break;
      }
      return { page: document.documentElement.scrollWidth, out };
    } finally { if (column) column.style.minWidth = before; }
  });
  return `with the column free to shrink the page is ${found.page} px; boxes sticking out: ${JSON.stringify(found.out)}`;
}
/** A server read of the part's process document (the saved rows, with their keys). */
async function readDocument(page, ctx, partId) {
  // Recover one expired keep-alive socket on a read; Playwright retries only ECONNRESET.
  const res = await page.request.get(`${ctx.baseURL}/api/parts/${partId}/process/document`, { maxRetries: 1 });
  assert.equal(res.status(), 200, "The process document is readable");
  return res.json();
}
const keyOf = (document, stepId, label) => document.revision.steps.find(s => s.id === stepId)?.parameters.find(p => p.label === label)?.key;

export async function run(page, shot, ctx) {
  const f = ctx.fixtures;
  const A = f.stepCodeA.code, B = f.stepCodeB.code;
  await page.setViewportSize({ width: 1440, height: 900 });
  // The default editor itself saves the exclusively owned code. No part action under test is
  // replaced with a fixture write.
  await page.goto(`${ctx.baseURL}/admin/step-codes`);
  for (const [code, instructions] of [[f.stepCodeA, defaultText], [f.stepCodeB, secondDefaultText]]) {
    await openRecordTab(page, "Codes");
    await page.getByRole("button", { name: code.code, exact: true }).click(); // a row opens Selected code
    const defaultResponse = page.waitForResponse(r => r.url().endsWith(`/api/admin/step-codes/${code.id}`) && r.request().method() === "PUT");
    await page.getByLabel(/^Standard instructions/).fill(instructions);
    await page.getByLabel(/^Standard instructions/).press("Tab");
    assert.equal((await defaultResponse).status(), 200);
  }

  await page.goto(`${ctx.baseURL}/parts/${f.partId}`);
  // This makes the real order creation produce two real loads.
  const partSaved = page.waitForResponse(r => r.url().endsWith(`/api/parts/${f.partId}`) && r.request().method() === "PATCH");
  await page.getByLabel("Load quantity", { exact: true }).fill("5");
  await page.getByLabel("Load quantity", { exact: true }).press("Tab");
  assert.equal((await partSaved).status(), 200);
  await openRecordTab(page, "Process recipe");
  // The part enters with its two saved steps, the heat and wash steps typed-fields and
  // revision-cut left, on revision-cut's working revision.
  await waitForValue(labelled(page, "Step 2 instructions"), "Rinse and inspect the load.");
  const rev = Number(await labelled(page, "Process revision").inputValue());
  assert.ok(rev >= 1, "The part carries a current revision");
  await section(page).getByText(`Rev ${rev} · working`, { exact: true }).waitFor();
  let state = await table(page);
  assert.deepEqual(state.map(row => row.code), [A, B]);
  const [s1, s2] = state.map(row => row.id);
  assert.ok([s1, s2].every(id => id && !id.startsWith("new:")), "Saved rows carry their server identities");
  // The sign-off cue shows at this width; the 863 px check below proves it hides.
  assert.deepEqual(await cueDisplays(page), ["table-cell"], "The EQ# · OP · Date cue shows on a wide screen");
  const search = section(page).getByRole("combobox", { name: SEARCH, exact: true });

  // 1. Add. A code prefix (typed in lower case: the search ignores case) finds the code as the
  //    active option, which names what the code suggests, and Enter picks it. (Each fixture query
  //    matches one code, so the ranking itself is pinned by tests/process-code-search.test.ts.)
  //    The step lands at the end with the code's standard instruction and suggested parameters,
  //    and focus goes to its first empty parameter value.
  const suggests = await pickProcessCode(page, "e2e-qn", f.stepCodeA);
  assert.match(suggests, /Suggests: Temperature \(°F\), Passed$/, "The option names the code's suggested parameters");
  await waitForFocused(labelled(page, "Step 3 Temperature"), "the new step's first empty parameter value");
  state = await table(page);
  assert.match(state[2].id, /^new:/, "An added step carries a provisional identity until it is saved");
  assert.deepEqual(withoutIds(state).slice(2), [{ code: A, instruction: defaultText, parameters: [emptyTemperature, emptyPassed] }]);
  // Task 1 carry: the standard instruction is copied once and customized before saving.
  await fillReliable(labelled(page, "Step 3 instructions"), "Custom line\n\nReviewed part text");
  // A word of the code's name finds it too; a code that suggests nothing focuses the instruction.
  await pickProcessCode(page, "wash", f.stepCodeB);
  await waitForFocused(labelled(page, "Step 4 instructions"), "the instruction of a new step with no parameters");
  await waitForValue(labelled(page, "Step 4 instructions"), secondDefaultText);
  const n3 = (await ids(page))[2], n4 = (await ids(page))[3];

  // 2. Insert. The + Insert chip shows on a hovered row's top edge and opens the search at that
  //    position; ↑/↓ move the active option and Enter picks the active one.
  await rows(page).nth(1).hover();
  await button(page, "Insert a step above step 2").click();
  await waitForFocused(search, "the step search, opened by the + Insert chip");
  await section(page).getByText("Inserting before step 2", { exact: true }).waitFor();
  await search.fill("e2e-q");
  const options = section(page).getByRole("listbox", { name: "Process codes", exact: true }).getByRole("option");
  await options.nth(1).waitFor();
  await search.press("ArrowDown");
  assert.equal(await options.nth(1).getAttribute("aria-selected"), "true", "ArrowDown activates the second option");
  await search.press("ArrowUp");
  assert.equal(await options.nth(0).getAttribute("aria-selected"), "true", "ArrowUp returns to the first option");
  await pickProcessCode(page, "e2e-qn", f.stepCodeA);
  await waitForFocused(labelled(page, "Step 2 Temperature"), "the inserted step's first empty parameter value");
  // Task 1 carry: an explicit blank instruction stays blank through the save below.
  await fillReliable(labelled(page, "Step 2 instructions"), "");
  // ⋮ → Insert step below opens the same search after that step.
  await menuAction(page, 3, "Insert step below");
  await waitForFocused(search, "the step search, opened from the ⋮ menu");
  await section(page).getByText("Inserting before step 4", { exact: true }).waitFor();
  await pickProcessCode(page, "wash", f.stepCodeB);
  await waitForFocused(labelled(page, "Step 4 instructions"), "the instruction of the step inserted below");
  state = await table(page);
  assert.deepEqual(state.map(row => row.code), [A, A, B, B, A, B]);
  const [, n5, , n6] = state.map(row => row.id);
  assert.deepEqual(state.map(row => row.id), [s1, n5, s2, n6, n3, n4]);
  assert.equal(new Set(state.map(row => row.id)).size, 6, "Repeated codes keep distinct client identities");
  // Esc in the search cancels: the rows stay as they were and focus returns to the opener.
  const beforeCancel = await ids(page);
  await menuAction(page, 1, "Insert step above");
  await section(page).getByText("Inserting before step 1", { exact: true }).waitFor();
  await waitForFocused(search, "the step search, opened for an insert above step 1");
  await search.fill("e2e");
  await search.press("Escape");
  await waitForFocused(button(page, "Step 1 actions"), "the ⋮ button that opened the search");
  assert.equal(await search.inputValue(), "", "Esc clears the query");
  await assertNeverVisible(section(page).getByText("Inserting before step 1", { exact: true }), "Esc closes the insert position", 500);
  assert.deepEqual(await ids(page), beforeCancel, "Esc leaves the rows unchanged");
  await shot("added-and-inserted");

  // 3. Reorder: ⋮ → Move down, Alt+↑ on a focused handle, then a native drag by the handle. Each
  //    move is announced and keeps focus on the moved step's handle.
  await menuAction(page, 1, "Move down");
  await section(page).getByText("Step 1 moved to position 2", { exact: true }).waitFor();
  await waitForFocused(button(page, "Move step 2"), "the handle of the step moved down");
  assert.deepEqual(await ids(page), [n5, s1, s2, n6, n3, n4]);
  await button(page, "Move step 6").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await section(page).getByText("Step 6 moved to position 5", { exact: true }).waitFor();
  // The editor focuses the moved step's handle one animation frame after it announces the move,
  // and only the handle answers Alt+Arrow (#350).
  await waitForFocused(button(page, "Move step 5"), "the handle of the step moved up");
  assert.deepEqual(await ids(page), [n5, s1, s2, n6, n4, n3]);
  const moved = await dragHandle(page, "Move step 5", "Move step 1");
  assert.ok(moved.trace.some(event => event.type === "drop" && event.step === n5), `Native drop must reach the first row: ${JSON.stringify(moved.trace)}`);
  await section(page).getByText("Step 5 moved to position 1", { exact: true }).waitFor();
  assert.deepEqual(await ids(page), [n4, n5, s1, s2, n6, n3]);
  // A drag cancelled with Esc changes nothing, though it is released over ANOTHER row: released on
  // step 3's handle without Esc, step 1 would move there. (A release on the dragged step's own row
  // moves nothing by construction, so it could not prove the cancel.)
  const beforeDragCancel = await ids(page);
  const announcement = section(page).locator("p.sr-only[role=status]");
  const announced = await announcement.textContent();
  const cancelled = await dragHandle(page, "Move step 1", "Move step 3", { cancel: true });
  assert.ok(cancelled.beforeRelease.some(event => event.type === "dragstart" && event.step === beforeDragCancel[0]),
    `The cancelled gesture is a real drag of step 1: ${JSON.stringify(cancelled.trace)}`);
  assert.equal(cancelled.beforeRelease.filter(event => event.type === "dragover").at(-1)?.step, beforeDragCancel[2],
    `Esc is pressed while the drag is over step 3's row: ${JSON.stringify(cancelled.trace)}`);
  await assertNeverVisible(section(page).getByText("Step 1 moved to position 3", { exact: true }), "A cancelled drag announces no move", 1000);
  assert.equal(await announcement.textContent(), announced, "The move announcement still names the last real move");
  assert.deepEqual(await ids(page), beforeDragCancel, "A cancelled drag changes nothing");

  // 4. Parameters. + Parameter (on a hovered row's bottom edge) adds a text row and focuses its
  //    name; an empty value is outlined amber; ⋮ → Add parameter does the same and ✕ removes one.
  await rows(page).nth(3).hover();
  await button(page, "Add a parameter to step 4").click();
  await waitForFocused(labelled(page, "Step 4 parameter 1 name"), "the new parameter's name");
  assert.match(await labelled(page, "Step 4 parameter 1 value").getAttribute("class") ?? "", /\bring-accent-400\b/, "An empty value is outlined in the accent");
  await fillReliable(labelled(page, "Step 4 parameter 1 name"), "Rinse temp");
  await fillReliable(labelled(page, "Step 4 Rinse temp"), "140");
  assert.doesNotMatch(await labelled(page, "Step 4 Rinse temp").getAttribute("class") ?? "", /\bring-accent-400\b/, "A filled value loses the outline");
  await fillReliable(labelled(page, "Step 4 Rinse temp unit"), "°F");
  await menuAction(page, 4, "Add parameter");
  await waitForFocused(labelled(page, "Step 4 parameter 2 name"), "the second new parameter's name");
  await fillReliable(labelled(page, "Step 4 parameter 2 name"), "Scratch");
  await button(page, "Remove Scratch from step 4").click();
  assert.deepEqual((await table(page))[3].parameters, [{ name: "Rinse temp", value: "140", unit: "°F", blank: false }], "✕ removes only its own row");
  // A suggested row's unit edit: the server gives the row a new key on save, which nobody sees.
  const documentBefore = await readDocument(page, ctx, f.partId);
  const suggestedKey = keyOf(documentBefore, s1, "Temperature");
  assert.ok(suggestedKey, "The saved heat step carries its Temperature row");
  await fillReliable(labelled(page, "Step 3 Temperature"), "1550.50");
  await fillReliable(labelled(page, "Step 3 Temperature unit"), "°C");

  // 5. Remove and Undo: ⋮ → Remove step takes the row out at once and offers Undo, which puts the
  //    same row back in the same place. Removed again, it stays removed.
  const beforeRemove = await table(page);
  await menuAction(page, 5, "Remove step");
  const undo = button(page, "Undo");
  await waitForFocused(undo, "Undo, after the removal took the focused row away");
  assert.match(await undo.locator("xpath=..").textContent() ?? "", /^Step 5 removed\./);
  assert.deepEqual(await ids(page), [n4, n5, s1, s2, n3]);
  await undo.click();
  await waitForFocused(button(page, "Move step 5"), "the restored step's handle");
  assert.deepEqual(await table(page), beforeRemove, "Undo restores the same row at the same place");
  await menuAction(page, 5, "Remove step");
  await undo.waitFor();
  assert.deepEqual(await ids(page), [n4, n5, s1, s2, n3]);

  // 7. Conflict: a refused save keeps every edit and says so.
  const documentUrl = `${ctx.baseURL}/api/parts/${f.partId}/process/document`;
  await fillReliable(labelled(page, "Step 3 instructions"), "Retained after refusal");
  const beforeRefusal = await table(page);
  const refuse = route => route.request().method() === "PUT" ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Fixture save refusal" }) }) : route.continue();
  const stopRefuse = await routeRequests(page, documentUrl, refuse);
  // #659: a 409 makes the section read itself again. The fixture's refusal changed no token, so
  // the read lands the same baseline and editing continues. The read's GET of the document passes
  // through the route, and the identity read is its last request, so both are awaited: nothing is
  // in flight when the route goes (#340).
  const reread = page.waitForResponse(res => res.url() === documentUrl && res.request().method() === "GET" && res.ok());
  const identityRead = page.waitForResponse(res => res.url() === `${ctx.baseURL}/api/auth/me` && res.request().method() === "GET" && res.ok());
  await button(page, "Save process steps").click();
  await section(page).getByText("Save failed — draft retained", { exact: true }).waitFor();
  await section(page).getByRole("alert").filter({ hasText: "Fixture save refusal" }).waitFor();
  await reread;
  await identityRead;
  await stopRefuse();
  assert.deepEqual(await table(page), beforeRefusal, "A refused save keeps the draft");
  await section(page).getByText("Save failed — draft retained", { exact: true }).waitFor();

  // 6. Save. Hold the real acknowledged save: both saves are disabled while it is open, and input
  //    typed meanwhile survives its acknowledgement.
  await labelled(page, "Recipe number").fill("E2E-TASK6");
  assert.equal(await button(page, "Save recipe").isEnabled(), true);
  let release, accepted, finished, started = false;
  const hold = new Promise(resolve => { release = resolve; });
  const committed = new Promise(resolve => { accepted = resolve; });
  const drainedSave = new Promise(resolve => { finished = resolve; });
  const controlled = async route => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    started = true;
    try {
      const response = await ctx.apiMutate(page, documentUrl, { method: "PUT", data: route.request().postDataJSON() });
      accepted({ status: response.status() }); await hold; await route.fulfill({ response });
    } catch (error) { accepted({ status: 0, error: String(error) }); await route.abort().catch(() => {}); }
    finally { finished({ done: true }); }
  };
  const stopControlled = await routeRequests(page, documentUrl, controlled);
  try {
    await button(page, "Save process steps").click();
    assert.equal((await bounded(committed, "Save must commit before late edits")).status, 200);
    assert.equal(await button(page, "Save process steps").isDisabled(), true);
    assert.equal(await button(page, "Save recipe").isDisabled(), true, "Recipe save is serialized with process save");
    assert.equal(await button(page, "Discard process changes").getAttribute("title"), "Saving — Discard is unavailable until the save settles.");
    await fillReliable(labelled(page, "Step 3 instructions"), "Late edit survives acknowledgment");
    release(); await bounded(drainedSave, "Held save response must drain");
    // The acknowledgement settles with a refresh needed (the document settle sets needsRefresh), and
    // the section then reads the process again. "Unsaved process changes" cannot render while that
    // refresh is needed, so it appears only once the refresh's reads have landed, and no request is
    // being issued when the route goes: the one that may still be open, the History panel's
    // refetch, started with the refresh (#340).
    await section(page).getByText("Unsaved process changes", { exact: true }).waitFor();
    await stopControlled();
    await waitForValue(labelled(page, "Step 3 instructions"), "Late edit survives acknowledgment");
    await save(page);
  } finally {
    release();
    if (started) await bounded(drainedSave, "Held save must finish before cleanup");
    await stopControlled();
  }
  await button(page, "Save recipe").click();
  await waitForProcessSaveSettled(page);

  // Reload: the order, the instructions (customized, explicitly blank, copied), every parameter
  // and every blank are what was saved.
  await page.reload();
  await waitForValue(labelled(page, "Step 3 instructions"), "Late edit survives acknowledgment");
  state = await table(page);
  assert.deepEqual(withoutIds(state), [
    { code: B, instruction: secondDefaultText, parameters: [] },
    { code: A, instruction: "", parameters: [emptyTemperature, emptyPassed] },
    { code: A, instruction: "Late edit survives acknowledgment", parameters: [{ name: "Temperature", value: "1550.50", unit: "°C", blank: false }, { name: "Passed", value: "true", unit: "", blank: false }] },
    { code: B, instruction: "Rinse and inspect the load.", parameters: [{ name: "Rinse temp", value: "140", unit: "°F", blank: false }] },
    { code: A, instruction: "Custom line\n\nReviewed part text", parameters: [emptyTemperature, emptyPassed] },
  ], "The saved process reads back exactly as edited");
  assert.equal(state[2].id, s1, "An existing step keeps its identity");
  assert.equal(state[3].id, s2);
  assert.ok(state.every(row => !row.id.startsWith("new:")), "Every added step received its server identity");
  assert.equal(await labelled(page, "Recipe number").inputValue(), "E2E-TASK6");
  // The unit edit re-keyed the row server-side (one key means one type and one unit) — and the
  // operator sees none of it: no key is rendered anywhere in the section.
  const documentAfter = await readDocument(page, ctx, f.partId);
  const rekeyed = keyOf(documentAfter, s1, "Temperature");
  assert.ok(rekeyed && rekeyed !== suggestedKey, "A unit edit gives the suggested row a new key");
  const rendered = await section(page).evaluate(root => [root.outerHTML, ...[...root.querySelectorAll("input, textarea")].map(el => el.value)].join("\n"));
  assert.ok(!rendered.includes(rekeyed) && !rendered.includes(suggestedKey), "Parameter keys are never shown to the operator");
  // A later catalog default edit never rewrites the instruction a step already copied.
  const copiedDefault = state[0].id;
  const changed = await ctx.apiMutate(page, `${ctx.baseURL}/api/admin/step-codes/${f.stepCodeB.id}`, { method: "PUT", data: { defaultInstruction: changedDefault } });
  assert.equal(changed.ok(), true, "Later catalog default edit succeeds");
  await page.reload();
  await waitForValue(section(page).locator(`tr[data-step-id="${copiedDefault}"]`).getByPlaceholder("Instruction"), secondDefaultText);

  // 13. The table figure for the manual.
  const flowDir = path.dirname(await shot("editor-wide-1440x900"));
  const stickyHeader = section(page).locator(":scope > div").first();
  const headerPosition = await stickyHeader.evaluate(element => element.style.position);
  try {
    // The header row is sticky: take it out of the flow while the table is photographed, so it is
    // never drawn over the table's first rows. No hovered row (no edge chips) and no focus ring.
    await stickyHeader.evaluate(element => { element.style.position = "static"; });
    await page.mouse.move(0, 0);
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await section(page).locator("#process-steps-table").screenshot({ path: path.join(flowDir, "manual-process-editor.png") });
  } finally {
    await stickyHeader.evaluate((element, position) => { element.style.position = position; }, headerPosition);
  }

  // 8. Revisions. A real order, entered with the now-saved process, locks the current revision.
  await page.goto(`${ctx.baseURL}/orders/new`);
  await pickCombobox(page, "Customer", f.customerCode, new RegExp(`^${f.customerCode}`));
  await page.getByRole("tab", { name: "Parts & containers", exact: true }).click();
  await pickCombobox(page, "Line 1 part", f.partNumber, new RegExp(`^${f.partNumber}`));
  await page.getByLabel("Line 1 quantity", { exact: true }).fill("10");
  await page.getByRole("tab", { name: "Process & loads", exact: true }).click();
  await page.getByText("Fully allocated · 0 pieces remaining", { exact: true }).waitFor();
  const orderResponse = page.waitForResponse(r => new URL(r.url()).pathname === "/api/orders" && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save only", exact: true }).click();
  const savedOrderResponse = await orderResponse;
  assert.equal(savedOrderResponse.ok(), true);
  const savedOrder = await savedOrderResponse.json();
  const go = page.getByRole("button", { name: "Go to order", exact: true });
  if (savedOrder.warnings.length) { await page.getByText(/^Order #\d+ saved\.$/).waitFor({ timeout: 20000 }); await go.click(); }
  const hubHeading = page.getByRole("heading", { name: /^Order #\d+/ });
  await hubHeading.waitFor();
  const orderNumber = Number(((await hubHeading.textContent()) ?? "").match(/#(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(orderNumber), "The hub names the saved order's number");
  const orderId = page.url().split("/").pop();
  // These GETs only observe immutable snapshots. Playwright can reuse a keep-alive socket just as
  // it expires; retry one ECONNRESET after discarding it. Do not retry writes or replay this flow
  // after its mutations have committed.
  const lockedBefore = await page.request.get(`${ctx.baseURL}/api/orders/${orderId}/process`, { maxRetries: 1 });
  assert.equal(lockedBefore.ok(), true, "Prior order snapshot is readable before later part edits");
  const lockedSnapshot = await lockedBefore.text();
  const archived = await ctx.apiMutate(page, `${ctx.baseURL}/api/orders/${orderId}/traveler?load=1`, { method: "POST" });
  assert.equal(archived.ok(), true, "Stored traveler is created from the locked order");
  const archivedDocumentId = archived.headers()["x-document-id"];
  assert.ok(archivedDocumentId, "Traveler response identifies its stored document");
  const archivedBytes = await archived.body();
  assert.equal(archivedBytes.subarray(0, 5).toString("latin1"), "%PDF-");

  await page.goto(`${ctx.baseURL}/parts/${f.partId}`);
  await openRecordTab(page, "Process recipe");
  await section(page).getByText(`Rev ${rev} · locked`, { exact: true }).waitFor();
  await section(page).getByText(`Saving creates Rev ${rev + 1}. The 1 order on Rev ${rev} keeps it.`, { exact: true }).waitFor();
  const picker = labelled(page, "Process revision");
  assert.equal(await picker.inputValue(), String(rev));
  assert.equal(await picker.locator(`option[value="${rev}"]`).textContent(), `Rev ${rev} · on 1 order`);
  await shot("locked-revision-on-1-order");

  // 9. Preview dialog: the real traveler for the current draft, around the newest order and its
  //    lowest load.
  const dialog = dialogOf(page);
  const iframe = dialog.locator('iframe[title="Draft process traveler PDF"]');
  const contextLine = load => dialog.getByText(new RegExp(`^Order ${orderNumber} · Load ${load} · Template:`));
  await button(page, "Preview traveler").click();
  await dialog.getByText("1 page · Fits on one page", { exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await dialog.getByLabel("Order and load", { exact: true }).inputValue(), `${orderId}:1`, "Opens on the newest order with its lowest load");
  await contextLine(1).waitFor();
  assert.match(await iframe.getAttribute("src") ?? "", /^blob:/, "Every browser receives the validated draft PDF Blob");
  if (process.env.E2E_BROWSER_CHANNEL === "chromium") {
    const previewFrame = await iframe.elementHandle().then(handle => handle?.contentFrame());
    assert.ok(previewFrame, "Full Chromium attaches the draft PDF iframe");
    await previewFrame.waitForLoadState("load");
    const viewer = await page.evaluate(() => ({ enabled: navigator.pdfViewerEnabled, plugins: [...navigator.plugins].map(plugin => plugin.name) }));
    assert.equal(viewer.enabled, true, "Full Chromium exposes its native PDF viewer");
    assert.ok(viewer.plugins.some(name => /PDF Viewer/i.test(name)), "A native PDF viewer plugin is registered");
    const isViewerFrame = frame => {
      if (!frame.url().startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/")) return false;
      for (let parent = frame.parentFrame(); parent; parent = parent.parentFrame()) if (parent === previewFrame) return true;
      return false;
    };
    let nativeViewerFrame = page.frames().find(isViewerFrame);
    if (!nativeViewerFrame) nativeViewerFrame = await page.waitForEvent("framenavigated", { predicate: isViewerFrame, timeout: 20000 });
    await nativeViewerFrame.locator("pdf-viewer").waitFor({ state: "visible", timeout: 20000 });
    const loadedPdf = await nativeViewerFrame.waitForFunction(() => {
      const element = document.querySelector("pdf-viewer");
      if (!element) return false;
      const box = element.getBoundingClientRect();
      return element.initialLoadComplete_ === true && element.loadState_ === "success" && element.documentDimensions !== null && box.width > 0 && box.height > 0;
    }, undefined, { timeout: 20000 });
    assert.equal(await loadedPdf.jsonValue(), true, "Native PDF viewer finished loading document dimensions");
    console.log("Process PDF viewer:", JSON.stringify(viewer));
  }
  // 13. The preview figure for the manual (a real PDF only in full Chromium's native viewer).
  await iframe.screenshot({ path: path.join(flowDir, "manual-process-traveler-preview.png") });
  await shot("preview-dialog-1440x900");
  // Escape closes the dialog and Preview traveler opens it again: the dialog's close event keeps
  // the section's open state in step with the element.
  await dialog.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await button(page, "Preview traveler").click();
  await dialog.getByText("1 page · Fits on one page", { exact: true }).waitFor({ timeout: 20000 });
  await contextLine(1).waitFor();

  // Switching the load hides the old PDF at once; a switch while a render is held queues behind it,
  // so at most one preview request is ever in flight.
  const previewUrl = `${ctx.baseURL}/api/parts/${f.partId}/process/preview`;
  let releasePreview, previewStarted, held = false, inFlight = 0, peak = 0;
  const previewHold = new Promise(resolve => { releasePreview = resolve; });
  const previewReady = new Promise(resolve => { previewStarted = resolve; });
  const renderedLoads = [];
  const delayed = async route => {
    inFlight++; peak = Math.max(peak, inFlight);
    const body = route.request().postDataJSON();
    try {
      const response = await ctx.apiMutate(page, previewUrl, { method: "POST", data: body });
      if (!held) { held = true; previewStarted({ status: response.status() }); await previewHold; }
      if (response.ok() && body.context?.loadNumber === 2) await fs.writeFile(path.join(flowDir, "draft-load-2.pdf"), await response.body());
      await route.fulfill({ response });
      renderedLoads.push(body.context?.loadNumber ?? null);
    } catch (error) {
      previewStarted({ status: 0, error: String(error) });
      await route.abort().catch(() => {});
    } finally { inFlight--; }
  };
  const orderAndLoad = dialog.getByLabel("Order and load", { exact: true });
  const stopDelayed = await routeRequests(page, previewUrl, delayed);
  try {
    await orderAndLoad.selectOption(`${orderId}:2`);
    await assertNeverVisible(iframe, "Switching the load hides the old PDF immediately", 500);
    assert.equal((await bounded(previewReady, "The switched load must render")).status, 200);
    await orderAndLoad.selectOption(`${orderId}:1`);
    // A picked load renders at once (#660); a second later, a render that ignored the queue would be
    // in flight beside the held one.
    await page.waitForTimeout(1000);
    assert.equal(inFlight, 1, "The second switch waits behind the held render");
    releasePreview();
    await contextLine(1).waitFor({ timeout: 20000 });
    await until(() => inFlight === 0 && renderedLoads.length === 2, "both preview renders answered");
    assert.equal(peak, 1, "Only one preview request is in flight");
    assert.deepEqual(renderedLoads, [2, 1], "The held render answered before the queued one ran");
  } finally {
    releasePreview();
    await until(() => inFlight === 0, "preview renders drained before cleanup");
    await stopDelayed();
  }
  // An invalid response shows the retry message and never a PDF; Retry preview recovers.
  const invalid = route => route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  const stopInvalid = await routeRequests(page, previewUrl, invalid);
  await dialog.getByRole("button", { name: "Refresh preview", exact: true }).click();
  await dialog.getByText("The server returned an invalid PDF preview. Retry the preview.", { exact: true }).waitFor();
  await assertNeverVisible(iframe, "An invalid response never shows a PDF");
  await stopInvalid();
  await dialog.getByRole("button", { name: "Retry preview", exact: true }).click();
  await contextLine(1).waitFor({ timeout: 20000 });
  await dialog.getByText("1 page · Fits on one page", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  // Overflow: edit behind the closed dialog, then open it on the longer draft.
  await fillReliable(labelled(page, "Step 1 instructions"), "Readable overflow line\n".repeat(100));
  const overflowResponse = page.waitForResponse(r => r.url() === previewUrl && r.request().method() === "POST" && r.ok() && Number(r.headers()["x-preview-page-count"]) > 1);
  await button(page, "Preview traveler").click();
  await dialog.getByText(/Continues on additional pages/).waitFor({ timeout: 20000 });
  await overflowResponse;
  const overflowBlobUrl = await iframe.getAttribute("src");
  assert.match(overflowBlobUrl ?? "", /^blob:/, "Overflow artifact comes from the current displayed preview Blob");
  const overflowBase64 = await page.evaluate(async url => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  }, overflowBlobUrl);
  const overflowBytes = Buffer.from(overflowBase64, "base64");
  assert.ok(overflowBytes.length > 5, "Displayed overflow PDF has a nonempty body");
  assert.equal(overflowBytes.subarray(0, 5).toString("latin1"), "%PDF-", "Displayed overflow artifact is a PDF");
  await fs.writeFile(path.join(flowDir, "draft-overflow.pdf"), overflowBytes);
  await shot("editor-overflow");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });

  // 8, continued. Saving the locked revision cuts the next one; the order keeps its revision and
  // its stored traveler, byte for byte.
  await fillReliable(labelled(page, "Step 1 instructions"), "Reviewed wash\n\nInspector: ________");
  await save(page);
  await section(page).getByText(`Rev ${rev + 1} · working`, { exact: true }).waitFor();
  await assertNeverVisible(section(page).getByText(/^Saving creates Rev /), "A working revision carries no cut note", 500);
  const lockedAfter = await page.request.get(`${ctx.baseURL}/api/orders/${orderId}/process`, { maxRetries: 1 });
  assert.equal(lockedAfter.ok(), true);
  assert.equal(await lockedAfter.text(), lockedSnapshot, "Later part edits leave the prior order snapshot unchanged");
  const archivedAfter = await page.request.get(`${ctx.baseURL}/api/documents/${archivedDocumentId}`, { maxRetries: 1 });
  assert.equal(archivedAfter.ok(), true);
  assert.deepEqual(await archivedAfter.body(), archivedBytes, "Later part edits leave stored traveler bytes unchanged");
  // The superseded revision opens read-only, unchanged, with a way back.
  await picker.selectOption(String(rev));
  await section(page).getByText(`Rev ${rev} is superseded and read-only.`, { exact: true }).waitFor();
  const historical = labelled(page, "Step 1 instructions");
  await waitForValue(historical, secondDefaultText);
  assert.equal(await historical.isDisabled(), true, "A superseded revision is read-only");
  assert.equal(await historical.getAttribute("title"), "Superseded revision — read-only");
  await assertDisabledChipsRevealOnHover(page, 1, "Superseded revision — read-only");
  await shot("superseded-revision-read-only");
  await button(page, "Current revision").click();
  await section(page).getByText(`Rev ${rev + 1} · working`, { exact: true }).waitFor();
  await waitForValue(labelled(page, "Step 1 instructions"), "Reviewed wash\n\nInspector: ________");
  assert.equal(await labelled(page, "Step 1 instructions").isEnabled(), true, "The current revision is editable again");

  // 11. Width: at 863 × 800 the page never scrolls sideways, the cue hides, and every control —
  //     the table's, a row's open menu and the dialog's — lies inside the viewport.
  await page.setViewportSize({ width: 863, height: 800 });
  const outside = async (root, selector) => root.evaluate((element, query) => {
    const width = document.documentElement.clientWidth; const found = []; let counted = 0;
    for (const control of element.querySelectorAll(query)) {
      if (control.closest("dialog") && !element.matches("dialog")) continue;
      const box = control.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      counted++;
      if (box.left < 0 || box.right > width) found.push(`${control.getAttribute("aria-label") ?? control.textContent?.trim()}: ${Math.round(box.left)}–${Math.round(box.right)}`);
    }
    return { counted, found };
  }, selector);
  const page863 = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  if (page863.scroll > page863.client) assert.fail(`No horizontal scroll at 863 px: ${JSON.stringify(page863)}; ${await overflowCulprits(page)}`);
  assert.deepEqual(await cueDisplays(page), ["none"], "The EQ# · OP · Date cue hides at a narrow width");
  const controls863 = await outside(section(page), "button, input, textarea, select");
  assert.ok(controls863.counted > 20, `The width check saw the section's controls (${controls863.counted})`);
  assert.deepEqual(controls863.found, [], "Every section control lies inside the viewport");
  await button(page, "Step 1 actions").click();
  const menu863 = await outside(section(page).getByRole("menu", { name: "Step 1 actions", exact: true }), '[role="menuitem"]');
  assert.equal(menu863.counted, 6);
  assert.deepEqual(menu863.found, [], "A row's open menu lies inside the viewport");
  await page.keyboard.press("Escape");
  await waitForFocused(button(page, "Step 1 actions"), "the ⋮ button, after Esc closed its menu");
  await shot("editor-863x800");
  await button(page, "Preview traveler").click();
  await dialog.getByText("1 page · Fits on one page", { exact: true }).waitFor({ timeout: 20000 });
  const dialog863 = await outside(dialog, "button, input, select, iframe");
  assert.ok(dialog863.counted >= 4, `The width check saw the dialog's controls (${dialog863.counted})`);
  assert.deepEqual(dialog863.found, [], "Every dialog control lies inside the viewport");
  await shot("editor-preview-863x800");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1440, height: 900 });

  // 10. SAMPLE: a second fictional part that leads no order (the order suite's rider part) previews
  //     its draft under a SAMPLE header. Its first step copies the code's CURRENT default.
  await page.goto(`${ctx.baseURL}/parts/${f.orderRiderPartId}`);
  await openRecordTab(page, "Process recipe");
  const noSteps = section(page).getByText("No steps yet. Search for a code below to add the first step.", { exact: true });
  await noSteps.waitFor();
  await pickProcessCode(page, "wash", f.stepCodeB);
  await waitForValue(labelled(page, "Step 1 instructions"), changedDefault);
  const riderPreviewUrl = `${ctx.baseURL}/api/parts/${f.orderRiderPartId}/process/preview`;
  const sampleResponse = page.waitForResponse(r => r.url() === riderPreviewUrl && r.request().method() === "POST");
  await button(page, "Preview traveler").click();
  await dialog.getByText("No order for this part has a load yet, so this preview has a SAMPLE header.", { exact: true }).waitFor();
  const sample = await sampleResponse;
  assert.equal(sample.status(), 200);
  assert.equal(sample.headers()["x-preview-sample"], "1", "The server rendered a SAMPLE header");
  assert.equal(sample.request().postDataJSON().context, null, "No order was invented for the SAMPLE");
  await dialog.getByText("1 page · Fits on one page", { exact: true }).waitFor({ timeout: 20000 });
  await dialog.getByText(/^SAMPLE · Template:/).waitFor();
  await shot("sample-preview");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  // Discard returns the part to its saved state: still no steps.
  await button(page, "Discard process changes").click();
  await noSteps.waitFor();
  assert.equal(await button(page, "Discard process changes").isDisabled(), true, "Nothing is left to discard");

  // 12. Restricted user (parts.view, processes.view): every edit control is disabled with its
  //     reason, and the preview offers a SAMPLE header with no order picker.
  await login(page, ctx.baseURL, f.restrictedUsername, f.restrictedPassword);
  await page.goto(`${ctx.baseURL}/parts/${f.partId}`);
  await openRecordTab(page, "Process recipe");
  await waitForValue(labelled(page, "Step 1 instructions"), "Reviewed wash\n\nInspector: ________");
  const restricted = await section(page).evaluate(root => [...root.querySelectorAll("button, input, textarea, select")]
    .filter(control => !control.closest("dialog"))
    .map(control => ({ name: control.getAttribute("aria-label") ?? control.closest("label")?.textContent?.trim() ?? control.textContent?.trim() ?? "", disabled: control.disabled, title: control.getAttribute("title") })));
  const viewing = new Set(["Preview traveler", "Process revision"]);
  const editing = restricted.filter(control => !viewing.has(control.name));
  assert.ok(editing.length > 20, `The restricted check saw the section's edit controls (${editing.length})`);
  assert.deepEqual(editing.filter(control => !control.disabled || control.title !== REQUIRES_EDIT), [], "Every edit control is disabled with its reason");
  assert.equal(restricted.find(control => control.name === "Preview traveler")?.disabled, false, "Preview traveler stays available");
  await assertDisabledChipsRevealOnHover(page, 1, REQUIRES_EDIT);
  const restrictedPreview = page.waitForResponse(r => r.url() === previewUrl && r.request().method() === "POST");
  await button(page, "Preview traveler").click();
  await dialog.getByText("A real order needs orders.view access, so this preview has a SAMPLE header.", { exact: true }).waitFor();
  const restrictedSample = await restrictedPreview;
  assert.equal(restrictedSample.status(), 200);
  assert.equal(restrictedSample.headers()["x-preview-sample"], "1", "Without orders.view the preview is a SAMPLE");
  assert.equal(restrictedSample.request().postDataJSON().context, null);
  await dialog.getByText("1 page · Fits on one page", { exact: true }).waitFor({ timeout: 20000 });
  await dialog.getByText(/^SAMPLE · Template:/).waitFor();
  await assertNeverVisible(dialog.getByLabel("Order and load", { exact: true }), "No order picker without orders.view", 500);
  await assertNeverVisible(dialog.getByLabel("Find existing order", { exact: true }), "No order search without orders.view", 500);
  await shot("restricted-preview-sample");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });

  // 5, continued — LAST, because Playwright's clock is installed for the whole browser context and
  // cannot be removed. The Undo window restarts with each removal: 16 s after the first removal,
  // but 6 s after the second, the second removal's bar still stands; 10 s later it is gone.
  await login(page, ctx.baseURL, f.adminUsername, f.adminPassword);
  await page.clock.install();
  await page.goto(`${ctx.baseURL}/parts/${f.partId}`);
  await openRecordTab(page, "Process recipe");
  await waitForValue(labelled(page, "Step 1 instructions"), "Reviewed wash\n\nInspector: ________");
  const undoBar = undo.locator("xpath=..");
  await menuAction(page, 1, "Remove step");
  await undo.waitFor();
  assert.match(await undoBar.textContent() ?? "", /^Step 1 removed\./);
  await page.clock.fastForward(10_000);
  await page.waitForTimeout(300);
  assert.match(await undoBar.textContent() ?? "", /^Step 1 removed\./, "10 s into the window the bar still stands");
  await menuAction(page, 2, "Remove step");
  await waitForText(undoBar, /^Step 2 removed\./, "the second removal's offer, replacing the first");
  await page.clock.fastForward(6_000);
  await page.waitForTimeout(300);
  assert.equal(await undo.isVisible(), true, "The window restarted with the second removal");
  assert.match(await undoBar.textContent() ?? "", /^Step 2 removed\./);
  await page.clock.fastForward(10_000);
  await undo.waitFor({ state: "detached" });
  assert.equal((await table(page)).length, 3, "The two removals stay drafted after the offer expires");
  await shot("undo-window-expired");
}
