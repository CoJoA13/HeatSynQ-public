// #495 items 1 and 2: Pick lists, Container types, on the fixture tote's Tare each box.
//
//   - Item 2 (Part A). The list read is answered 503 while Enter saves 61: the save is stored and
//     the reload after it fails, so the table's red line reads "Request failed (503)". The cursor
//     then leaves the box with its text unchanged, and nothing more is sent: one PUT in all, and one
//     more History entry for the row.
//   - Item 1 (Part B). With Show inactive unticked, 62 is saved on leaving the box, and that save is
//     held before it reaches the server. Show inactive is ticked while it is held. Once the save is
//     let through, the reload after it asks for the inactive rows too. The cursor leaves the box by
//     Tab and the save is seen going out before the tick, so the order of the two never rests on
//     the blur the tick's click would cause.
//
//   - #708 and #680 (Part C). A link opens the list it names, without the selector. On Terms a row's
//     Name saves in place with its Saved mark, one discount box left holds its text with the Add
//     row's hint and sends nothing, and the second sends both in one save.
//
// Part A's barrier is the Show inactive box. A save sent on leaving the box goes out as the cursor
// leaves it, so the flow ticks the box and waits for the read the tick starts before it counts the
// saves. If Show inactive stops reading the list itself (item 1), Part A therefore times out at
// that barrier rather than reporting item 2, and a red there is read with that in mind.
//
// Part C's writes are the fixture terms' name and discount, restored the same way.
//
// The one write of Parts A and B is the tote's Tare each, which is shared fixture state: the flow reads that the tote
// holds none first, arms the restore BEFORE the first write (#321) and puts it back to none through
// `ctx.apiMutate`, an exact-value PUT, reading it back after, failing or not. Every other flow that
// picks the tote runs before this one. Each 503 is a response the flow's own route gives, not a
// failed request, so the harness counts no network failure for it.
import assert from "node:assert/strict";
import { routeRequests } from "../route-keep-alive.mjs";
import { readJson } from "../lib/order-entry-workspace.mjs";
import { waitForChecked, waitForValue } from "../lib/ui.mjs";
import { answerModal, waitForModal } from "../lib/modal.mjs";
import { redLine, waitForRedLines, watchRequests } from "../lib/refusal-lines.mjs";

const LIST_PATH = "/api/admin/reference/containerType";

/** A read of the container types list, with or without the inactive rows. */
const isListRead = (request) =>
  request.method() === "GET" && new URL(request.url()).pathname === LIST_PATH;

/** The list read Show inactive asks for once it is ticked. */
const isInactiveListRead = (request) =>
  isListRead(request) && new URL(request.url()).search === "?includeInactive=1";

/** Settles within ten seconds, or fails naming `what`. For a promise Playwright does not bound. */
async function within(promise, what) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what} within 10 seconds` })), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function run(page, shot, ctx) {
  const id = ctx.fixtures.containerTypeId;
  const name = ctx.fixtures.containerTypeName;
  const rowPath = `${LIST_PATH}/${id}`;
  const storedTare = async () => {
    const row = (await readJson(page, ctx, LIST_PATH)).find((r) => r.id === id);
    assert.ok(row, `the fixture container type ${name} must be listed`);
    return row.tareEach;
  };
  assert.equal(await storedTare(), null, `the fixture container type ${name} starts with no Tare each`);

  // Armed before the first write. An exact-value PUT is safe to send twice.
  const restoreTare = async () => {
    const res = await ctx.apiMutate(page, `${ctx.baseURL}${rowPath}`, {
      method: "PUT", data: { tareEach: null }, idempotent: true });
    assert.equal(res.ok(), true, `restoring ${name}'s Tare each: ${await res.text()}`);
    assert.equal(await storedTare(), null, `${name}'s Tare each must be restored to none`);
  };

  let failed = true;
  try {
    await termsInPlace(page, shot, ctx);
    await page.goto(`${ctx.baseURL}/admin/reference`);
    await page.getByRole("button", { name: "Container types", exact: true }).click();
    const box = page.getByLabel(`Tare each (lb) for ${name}`, { exact: true });
    const toggle = page.getByLabel("Show inactive", { exact: true });
    await box.waitFor({ state: "visible", timeout: 15000 });
    await waitForValue(box, "");
    await waitForChecked(toggle, false);
    const part = { id, rowPath, box, toggle, storedTare };
    await enterThenLeave(page, shot, ctx, part);
    await reloadAfterTick(page, shot, part);
    failed = false;
  } finally {
    try {
      await restoreTare();
    } catch (error) {
      if (!failed) throw error;
      console.error(`pick-list-saves: restoring ${name}'s Tare each failed after the flow failed: ${error}`);
    }
  }
}

/** Part C: the link opens Terms, and a row's Name and its discount pair save in place. */
async function termsInPlace(page, shot, ctx) {
  const name = ctx.fixtures.arTermsName;
  const listPath = "/api/admin/reference/terms";
  const stored = async () => (await readJson(page, ctx, listPath)).find((r) => r.name.startsWith(name));
  const row = await stored();
  assert.ok(row, `the fixture terms ${name} must be listed`);
  assert.deepEqual([Number(row.discountPercent), row.discountDays], [2, 10], "the fixture terms start at 2/10");
  const rowPath = `${listPath}/${row.id}`;
  const restore = async () => {
    const res = await ctx.apiMutate(page, `${ctx.baseURL}${rowPath}`, {
      method: "PUT", data: { name, discountPercent: "2.00", discountDays: 10 }, idempotent: true });
    assert.equal(res.ok(), true, `restoring ${name}: ${await res.text()}`);
  };
  let failed = true;
  try {
    await page.goto(`${ctx.baseURL}/admin/reference?kind=terms`);
    const nameBox = page.getByLabel(`Name for ${name}`, { exact: true });
    await nameBox.waitFor({ state: "visible", timeout: 15000 });
    assert.equal(await page.getByRole("button", { name: "Terms", exact: true }).getAttribute("aria-current"), "true",
      "the link must open Terms");

    const puts = watchRequests(page, "PUT", rowPath, { exact: true });
    const renamed = `${name} X`;
    await nameBox.fill(renamed);
    await Promise.all([
      page.waitForResponse((res) => new URL(res.url()).pathname === rowPath && res.request().method() === "PUT"),
      nameBox.press("Enter"),
    ]);
    const renamedBox = page.getByLabel(`Name for ${renamed}`, { exact: true });
    await page.getByRole("status", { name: `Name for ${name} saved` }).or(page.getByRole("status", { name: `Name for ${renamed} saved` }))
      .waitFor({ state: "visible", timeout: 10000 });
    await waitForValue(renamedBox, renamed);
    assert.equal(puts.count(), 1, "Enter must store the new name once");

    const percent = page.getByLabel(`Discount % for ${renamed}`, { exact: true });
    const days = page.getByLabel(`Discount days for ${renamed}`, { exact: true });
    await percent.fill("");
    await percent.press("Tab");
    await page.getByRole("row").filter({ has: days }).getByText("needs Discount % too", { exact: true })
      .waitFor({ state: "visible", timeout: 10000 });
    assert.equal(puts.count(), 1, "one discount box cleared must send nothing");
    await shot("discount-box-holds");

    await percent.fill("3");
    const [saved] = await Promise.all([
      page.waitForResponse((res) => new URL(res.url()).pathname === rowPath && res.request().method() === "PUT"),
      percent.press("Enter"),
    ]);
    assert.deepEqual(JSON.parse(saved.request().postData()), { discountPercent: "3", discountDays: 10 },
      "the second box must send both in one save");
    await page.getByRole("status", { name: `Discount % for ${renamed} saved` }).waitFor({ state: "visible", timeout: 10000 });
    await percent.press("Tab");
    assert.equal(puts.count(), 2, "leaving the box after Enter must send nothing more");
    puts.stop();
    const after = await stored();
    assert.deepEqual([after.name, Number(after.discountPercent), after.discountDays], [renamed, 3, 10],
      "the row must hold the new name and the new pair");
    await shot("discount-pair-saved");

    // Choosing another list would drop a held box, so the button asks (Codex P2 on #864).
    await percent.fill("");
    await percent.press("Tab");
    const materials = page.getByRole("button", { name: "Materials", exact: true });
    await materials.click();
    await waitForModal(page, "choosing another list over a held discount must ask");
    await answerModal(page, { confirm: false });
    await waitForValue(percent, "");
    await materials.click();
    await waitForModal(page, "choosing another list again must ask again");
    await answerModal(page);
    await page.locator('button[aria-current="true"]').filter({ hasText: "Materials" })
      .waitFor({ state: "visible", timeout: 10000 });
    failed = false;
  } finally {
    try {
      await restore();
    } catch (error) {
      if (!failed) throw error;
      console.error(`pick-list-saves: restoring ${name} failed after the flow failed: ${error}`);
    }
  }
}

/** Part A, item 2: Enter stores 61 and the reload after it fails; leaving the box sends nothing. */
async function enterThenLeave(page, shot, ctx, { id, rowPath, box, toggle, storedTare }) {
  const historyPath = `/api/admin/audit?entity=containerType&entityId=${id}`;
  const entries = async () => (await readJson(page, ctx, historyPath)).rows.length;
  const before = await entries();

  const puts = watchRequests(page, "PUT", rowPath, { exact: true });
  const stopFailing = await routeRequests(page, (url) => url.pathname === LIST_PATH, async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  try {
    await box.fill("61");
    const [savedResponse] = await Promise.all([
      page.waitForResponse((res) => new URL(res.url()).pathname === rowPath && res.request().method() === "PUT"),
      page.waitForResponse((res) => isListRead(res.request()) && res.status() === 503),
      box.press("Enter"),
    ]);
    assert.equal(savedResponse.ok(), true, "Enter must store 61");
    await waitForRedLines(redLine(page), ["Request failed (503)"]);
  } finally {
    await stopFailing();
  }

  // The cursor leaves the box with 61 still in it. Then the barrier: Show inactive's own read.
  await box.press("Tab");
  const [ticked] = await Promise.all([
    page.waitForResponse((res) => isInactiveListRead(res.request())),
    toggle.check(),
  ]);
  assert.equal(ticked.ok(), true, "the Show inactive box's read must answer");
  assert.equal(puts.count(), 1, "leaving the box after Enter stored 61 must send nothing more");
  puts.stop();
  await waitForValue(box, "61");
  assert.equal(await entries(), before + 1, "the row's History must hold one more entry, for the one save");
  assert.equal(Number(await storedTare()), 61, "the stored Tare each must be 61");
  await shot("enter-then-leave-one-save");
}

/** Part B, item 1: a save held while Show inactive is ticked reloads with the inactive rows. */
async function reloadAfterTick(page, shot, { rowPath, box, toggle, storedTare }) {
  const [unticked] = await Promise.all([
    page.waitForResponse((res) => isListRead(res.request()) && new URL(res.url()).search === ""),
    toggle.uncheck(),
  ]);
  assert.equal(unticked.ok(), true, "the Show inactive box's read must answer once it is unticked");
  await waitForValue(box, "61");

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handled = [];
  const holdSave = (route) => {
    // Observe errors at once, and join the released handler BEFORE removing its route.
    const task = (async () => {
      if (route.request().method() === "PUT") await gate;
      await route.continue();
    })().then(() => null, (error) => error);
    handled.push(task);
    return task;
  };
  const stopHolding = await routeRequests(page, (url) => url.pathname === rowPath, holdSave);
  let savedResponse;
  let reload;
  try {
    await box.fill("62");
    await Promise.all([
      page.waitForRequest((req) => new URL(req.url()).pathname === rowPath && req.method() === "PUT"),
      box.press("Tab"),
    ]);
    const [ticked] = await Promise.all([
      page.waitForResponse((res) => isInactiveListRead(res.request())),
      toggle.check(),
    ]);
    assert.equal(ticked.ok(), true, "the Show inactive box's read must answer while the save is held");
    const nextRead = page.waitForRequest(isListRead);
    const saved = page.waitForResponse((res) =>
      new URL(res.url()).pathname === rowPath && res.request().method() === "PUT");
    release();
    [savedResponse, reload] = await Promise.all([saved, nextRead]);
  } finally {
    release();
    try {
      const failures = await within(Promise.all(handled), "the held save's route handler must finish once released");
      assert.deepEqual(failures.filter(Boolean), [], "the held save must be let through");
    } finally {
      await stopHolding();
    }
  }
  assert.equal(savedResponse.ok(), true, "leaving the box must store 62");
  assert.equal(new URL(reload.url()).search, "?includeInactive=1",
    "the reload after a save held while Show inactive was ticked must ask for the inactive rows");
  await waitForValue(box, "62");
  await waitForChecked(toggle, true);
  assert.equal(Number(await storedTare()), 62, "the stored Tare each must be 62");
  await shot("reload-reads-show-inactive");
}
