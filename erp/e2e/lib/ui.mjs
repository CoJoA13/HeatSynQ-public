// Small shared helpers so the flow modules don't each reinvent them.
import assert from "node:assert/strict";

/**
 * Drives one of this app's hand-built Combobox components (src/components/Combobox.tsx) —
 * the customer and part pickers on order entry/the hub, none of which are a plain `<select>`
 * (spec §11 calls for free-text autocomplete, which a native select can't do). `labelText` locates
 * the combobox's own `<input>` by its `aria-label` (every instance carries one — "Customer",
 * "Line 1 part", etc.); `filterText` is typed to narrow the dropdown to the option intended;
 * `optionNamePattern` matches the option by its accessible name (a regex anchored on the
 * option's own leading text, e.g. `/^E2E-ORD-LEAD/`, is normally enough — the label also
 * carries a trailing `— name` or `· name` this doesn't need to match). The options are located
 * by role="option", NOT "button": #37's WAI-ARIA pass gave each option button an explicit
 * option role, and an explicit role replaces the implicit button role in the accessibility
 * tree — getByRole("button") stopped matching them the moment that landed (group-H E2E run,
 * 14 flows red on exactly this line).
 *
 * `.click()` before `.fill()` is not strictly required (Playwright's `.fill()` focuses the element
 * itself, and this component opens its dropdown `onFocus`) but mirrors how a real user would
 * interact with it, and costs nothing extra.
 */
export async function pickCombobox(page, labelText, filterText, optionNamePattern) {
  const input = page.getByLabel(labelText, { exact: true });
  await input.click();
  await input.fill(filterText);
  await page.getByRole("option", { name: optionNamePattern }).click();
}

/**
 * Picks the option holding `value` (its `data-value`) in one of the app's Combobox pickers (#1056),
 * found by its `aria-label` inside `scope` (the page, or a section locator when one label repeats).
 * The picker opens on focus showing every option, so nothing is typed: the option is found by the id
 * a fixture carries, as `selectOption(id)` found a native option. A flow that proves the typing half
 * uses `pickCombobox`. The option list is looked up under the input's own wrapper, so a second picker
 * with the same option open elsewhere on the page cannot be clicked instead. Returns the input.
 */
export async function pickComboboxValue(scope, labelText, value) {
  const input = scope.getByLabel(labelText, { exact: true });
  await input.click();
  await input.locator("xpath=..").locator(`[role="option"][data-value="${value}"]`).click();
  return input;
}

/**
 * Opens a Combobox picker (`input`, its combobox locator) and picks the one option whose accessible
 * name matches `name` (a string matches exactly; a RegExp as written), without typing. Returns the
 * picked option's value, so a caller can assert the id it meant to pick. A name no option holds
 * times out on the click, as a missing native option did.
 */
export async function pickComboboxOption(input, name) {
  await input.click();
  const option = input.locator("xpath=..").getByRole("option", typeof name === "string" ? { name, exact: true } : { name });
  const value = (await option.getAttribute("data-value")) ?? "";
  await option.click();
  return value;
}

/** The value a Combobox picker holds (its input's `data-value`), where `inputValue()` reads the label
 * it shows: a native select's `inputValue()`, for a picker. */
export async function comboboxValue(input) {
  return (await input.getAttribute("data-value")) ?? "";
}

/** Polls until a Combobox picker holds `expected` (its `data-value`), as `waitForValue` polls a
 * native select's value. */
export async function waitForComboboxValue(input, expected, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await input.getAttribute("data-value").catch(() => undefined);
    if (last === expected) return;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for the picker to hold ${JSON.stringify(expected)}; last read ${JSON.stringify(last)}`);
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

/** The option texts a Combobox picker offers, in order: opens it, reads them, and closes it again
 * (Escape), leaving the cursor in it. */
export async function comboboxOptionTexts(input) {
  await input.click();
  const texts = await input.locator("xpath=..").getByRole("option").allTextContents();
  await input.press("Escape");
  return texts;
}

/**
 * Polls `locator.inputValue()` until it equals `expected` or `timeoutMs` elapses.
 *
 * Why this exists: a step's `<li>` becomes visible (and matches a `hasText` locator) as soon as
 * `detail.steps` updates, but ProcessStepsSection.tsx's typed-in `value` comes from a SEPARATE
 * `drafts` map rebuilt by its own effect (gated on `detail` AND `codesReady`) — a distinct React
 * commit that can land a render tick after the `<li>` itself first appears. `locator.inputValue()`
 * is a snapshot, not an auto-retrying assertion (unlike `@playwright/test`'s `expect(...)`, which
 * this harness doesn't use — HANDOFF §5a's bundled-Chromium path drives the raw `playwright`
 * library directly) — reading it right after `waitFor({state:"visible"})` on the container can
 * catch that brief empty-then-populated gap. This is a test-timing artifact, not an app bug: a
 * real user never perceives a same-tick React effect ordering gap.
 */
/**
 * Waits until `locator` is the page's focused element, failing with an assertion that names
 * `what` and the element that holds focus instead. For a control that moves focus a frame AFTER
 * the state change a flow waits on (#350: the process-step editor focuses a moved step's handle
 * in the next animation frame), a key pressed as soon as that state is visible lands on the
 * previously focused control.
 */
export async function waitForFocused(locator, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // No element yet (or a detached one) is simply "not focused yet".
    if (await locator.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    if (Date.now() > deadline) {
      // Read the focused element from the page itself: the locator may match nothing.
      const focused = await locator.page().evaluate(() => {
        const el = document.activeElement;
        return el ? (el.getAttribute("aria-label") ?? `<${el.tagName.toLowerCase()}>`) : null;
      }).catch(() => "(unreadable)");
      assert.fail(`Timed out waiting for ${what} to take focus; focus is on ${JSON.stringify(focused)}`);
    }
    await new Promise((r) => { setTimeout(r, 50); });
  }
}

export async function waitForValue(locator, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await locator.inputValue().catch(() => undefined);
    if (last === expected) return;
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting for value ${JSON.stringify(expected)} — last saw ${JSON.stringify(last)}`);
    }
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

/** Same race, for a checkbox's `checked` state — see `waitForValue`'s doc comment. */
export async function waitForChecked(locator, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await locator.isChecked().catch(() => undefined);
    if (last === expected) return;
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting for checked=${expected} — last saw ${JSON.stringify(last)}`);
    }
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

/**
 * Polls until `locator` is genuinely enabled.
 *
 * Not paranoia: a page that gates its controls runs TWO independent fetches, and the heading a flow
 * waits on is gated only on the record. `usePermissions` is the other, and every gate reads an
 * in-flight (`undefined`) permission array as "no grants" (src/lib/permission-ui.ts, deliberately,
 * so a control never flashes open and then locks). So a control that will settle ENABLED can render
 * disabled for a beat after the heading appears, and a one-shot `isDisabled()` read can catch that
 * beat. Moved here from reverse-shipment.mjs (#472), unchanged, so other flows can share it. The
 * saved shipment page is the exception since #483: it renders its heading only once the permission
 * read has answered too (`permissionsPending`, src/lib/permission-ui.ts).
 */
export async function waitForEnabled(locator, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await locator.isDisabled())) return;
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting for ${what} to become enabled (title: ${await locator.getAttribute("title")})`);
    }
    await new Promise((r) => { setTimeout(r, 200); });
  }
}

/**
 * What a rejected read of a locator rejected with, in words for a failure text. A read's own
 * timeout running out is how a locator reports an element that is not on the page, and is put as
 * "the element could not be read". Any other rejection is named by its own message: two elements
 * matching the locator is the usual one, and a closed page is another.
 *
 * For a poll that reads a locator again and again and fails with the last thing it read. One that
 * takes every rejected read for "nothing there" fails with the wrong cause. `waitForTitle` below
 * and the strip's wait in the hub-line-corrections flow both word a rejected read through this.
 */
export function unreadReason(rejection) {
  return rejection?.name === "TimeoutError" ? "the element could not be read"
    : `the read was rejected: ${rejection instanceof Error ? rejection.message : String(rejection)}`;
}

/**
 * Polls until `locator`'s `title` attribute is the one expected: a RegExp it must match, a string
 * it must equal, or `null` for no title at all. Fails naming `what` and the last title read.
 *
 * The same race as `waitForEnabled`, for a control that settles DISABLED. A gate tries its rungs in
 * order, and a rung below the permission rung is not reached until the permission fetch lands: until
 * then the title reads "Requires …" (not on the saved shipment page, which renders no control until
 * then, #483). A saved shipment's grid controls, and the order hub's grid Save buttons, read one
 * more title while the grid's own first read is in flight: its recovery notice's first sentence
 * (#483). A one-shot `getAttribute("title")` can catch either, so a flow that asserts such a title
 * waits for it here (#472).
 *
 * An element that is not on the page yet counts as no answer, never as "no title": `null` is
 * satisfied only by an element that exists and carries none.
 *
 * A read rejected for any other reason is no answer either, and the wait goes on, because some
 * rejections pass (a navigation in flight). One that is still there at the deadline fails the
 * wait with its own message. Two elements matching the locator is the usual one: Playwright
 * rejects that read at once, and reported as "could not be read" it cost a full timeout and hid
 * the cause.
 */
export async function waitForTitle(locator, expected, what, timeoutMs = 20000) {
  const holds = (title) => (expected === null ? title === null
    : expected instanceof RegExp ? typeof title === "string" && expected.test(title)
      : title === expected);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // `title` is a string, or `null` for an element that carries none. `rejection` is set, and
    // `title` left undefined, when the read gave no answer at all.
    const read = await locator.getAttribute("title", { timeout: 1000 })
      .then((title) => ({ title }), (rejection) => ({ title: undefined, rejection }));
    if (!("rejection" in read) && holds(read.title)) return;
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting for ${what} to carry ${expected === null ? "no title" : `the title ${String(expected)}`}; ` +
        `last read ${"rejection" in read ? `nothing (${unreadReason(read.rejection)})` : JSON.stringify(read.title)}`);
    }
    await new Promise((r) => { setTimeout(r, 200); });
  }
}

/**
 * Fills a field, then confirms the typed value actually held — re-filling once and polling if it
 * didn't.
 *
 * Why this exists: a field that just appeared because of an "Add" action (originally a new step's
 * boilerplate or instruction textarea, right after the add POST's own reload) can have a
 * state-sync effect from that SAME reload still scheduled — not yet run — at the instant `fill()`
 * dispatches its input event. A real user always loses that race by default (clicking, finding the
 * new field, and starting to type takes far longer than the microtask gap between a React commit
 * and its effect), but a script's `fill()` can land inside that gap, and when it does the effect runs
 * a moment later and silently overwrites the just-typed value back to server truth — same class
 * of test-timing artifact as `waitForValue` above, not an app bug, just on the write side instead
 * of the read side. One re-fill after the first mismatch is enough: nothing schedules a second
 * clobber unless another mutating action runs meanwhile, which these flows never do here.
 */
export async function fillReliable(locator, value, timeoutMs = 5000) {
  await locator.fill(value);
  const deadline = Date.now() + timeoutMs;
  let refilled = false;
  for (;;) {
    const current = await locator.inputValue().catch(() => undefined);
    if (current === value) return;
    if (!refilled) {
      await locator.fill(value);
      refilled = true;
    }
    if (Date.now() > deadline) {
      assert.fail(`fillReliable: value would not hold at ${JSON.stringify(value)} — last saw ${JSON.stringify(current)}`);
    }
    await new Promise((r) => { setTimeout(r, 150); });
  }
}

/** Same race, for a checkbox — see `fillReliable`'s doc comment. */
export async function checkReliable(locator, checked, timeoutMs = 5000) {
  await (checked ? locator.check() : locator.uncheck());
  const deadline = Date.now() + timeoutMs;
  let redone = false;
  for (;;) {
    const current = await locator.isChecked().catch(() => undefined);
    if (current === checked) return;
    if (!redone) {
      await (checked ? locator.check() : locator.uncheck());
      redone = true;
    }
    if (Date.now() > deadline) {
      assert.fail(`checkReliable: checked state would not hold at ${checked} — last saw ${JSON.stringify(current)}`);
    }
    await new Promise((r) => { setTimeout(r, 150); });
  }
}

/** Fails loudly with context instead of letting a mismatch surface as a bare assertion trace. Thin
 *  wrappers over `node:assert` deliberately (#193): an `AssertionError` carries `ERR_ASSERTION`,
 *  which `classifyFailure` hard-overrides on, so a mismatch here can never be laundered into a green
 *  network retry the way a plain `throw new Error` could. */
export function expectEqual(actual, expected, label) {
  assert.strictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function expectTrue(condition, label) {
  assert.ok(condition, `${label}: expected condition to be true`);
}

/**
 * "This element must NOT be on screen" — the one absence assertion the flows are allowed to make
 * (#167a fix round). It replaces the rejects-wrapped-waitFor shape (the anti-pattern the
 * `findUncheckedAbsenceAssertions` sweep now refuses across the whole suite, described in prose here
 * rather than written out so this file — swept since #192 — does not trip its own detector), which
 * was in nine places and is a FALSE-GREEN shape: that assertion passes on *any* rejection, and
 * Playwright rejects a `waitFor` for two entirely different reasons —
 *
 *   * the element never appeared        -> "Timeout 1500ms exceeded"      (what we mean)
 *   * SEVERAL elements matched          -> "strict mode violation: … resolved to 2 elements"
 *
 * — so the moment ambient data makes a locator match twice, the assertion swearing the element is
 * gone starts PASSING while it is on screen twice. `void-order.mjs` shipped exactly that: a voided
 * order still on the board plus one ambient cell holding the same digits, and the flow green.
 *
 * So the rejection is checked rather than merely awaited: a timeout is the pass, a strict-mode
 * violation is a named failure (the locator is too loose, which is a defect in its own right), and
 * anything else — a closed page, a transport error — is re-thrown untouched so the harness's
 * network/assertion classifier still sees it as itself.
 *
 * `assert.fail` deliberately, not `throw new Error`: an `ERR_ASSERTION` hard-overrides the netFailure
 * signal in `failure-classify.mjs`, which is what keeps "the element is still there" from being
 * laundered into a green retry.
 */
export async function assertNeverVisible(locator, message, timeoutMs = 1500) {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/strict mode violation/i.test(text)) {
      assert.fail(
        `${message} — but the locator is too loose to answer that: it resolved to SEVERAL ` +
        `elements, so "not visible" could never have been distinguished from "visible twice". ` +
        `Narrow it (the board's rows: boardRow() in e2e/lib/orders.mjs). Playwright said: ${text}`,
      );
    }
    if (!/Timeout \d+ms exceeded/.test(text)) throw err;
    return; // timed out waiting for it to appear — genuinely absent, which is the assertion
  }
  assert.fail(message);
}

/** `locator.waitFor({ state })` as an assertion (#573): a wait that runs out fails with `message`,
 *  never hangs, and a strict-mode violation or a transport error is rethrown as it came. */
export async function waitForState(locator, state, message, timeoutMs = 10000) {
  try {
    await locator.waitFor({ state, timeout: timeoutMs });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!/Timeout \d+ms exceeded/.test(text)) throw err;
    assert.fail(`${message} (not ${state} after ${timeoutMs} ms)`);
  }
}

/** The part page's Process steps section (spec 2026-09-26 §4), by its exact heading. */
export function processSection(page) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Process steps", exact: true }) });
}

/** The section's step rows, in order. Each is a `tr` carrying the step's client identity in
 *  `data-step-id` (a server id once saved, `new:<uuid>` before), inside `#process-steps-table`. */
export function processRows(page) {
  return processSection(page).locator("#process-steps-table > tbody > tr[data-step-id]");
}

/** The one step row whose Step column prints `code` (the column shows the code's name with the
 *  code beneath it). Exact, so `E2E-WASH` never matches a longer code. Only for a code the part
 *  uses once: a repeated code resolves to several rows, which Playwright's strict mode refuses. */
export function processRow(page, code) {
  return processRows(page).filter({ has: page.getByText(code, { exact: true }) });
}

/**
 * Adds a step through the search under the table: types `query`, requires the FIRST option (the
 * active one, which Enter picks) to be `code`, then presses Enter — it finds and picks the code,
 * deterministically. It is not a ranking check: the ranking (code prefix, name prefix, a word start
 * in the name, any substring) is pinned by tests/process-code-search.test.ts. The first option is
 * polled, not read once, so a list still showing the codes for an earlier query cannot answer.
 * Resolves with that option's text: `CODE — Name` followed by what the code suggests.
 */
export async function pickProcessCode(page, query, code, timeoutMs = 10000) {
  const section = processSection(page);
  const search = section.getByRole("combobox", { name: "Add a step — search code or name", exact: true });
  await search.fill(query);
  const first = section.getByRole("listbox", { name: "Process codes", exact: true }).getByRole("option").first();
  const expected = `${code.code} — ${code.name}`;
  const deadline = Date.now() + timeoutMs;
  let text;
  for (;;) {
    text = await first.textContent({ timeout: 1000 }).catch(() => null);
    if (text?.startsWith(expected)) break;
    if (Date.now() > deadline) assert.fail(`The first option for ${JSON.stringify(query)} must be ${expected}; saw ${JSON.stringify(text)}`);
    await new Promise((r) => { setTimeout(r, 100); });
  }
  assert.equal(await first.getAttribute("aria-selected"), "true", "The first option is the active one, which Enter picks");
  await search.press("Enter");
  return text;
}

/** Wait for the atomic process save's accepted refresh, not just its transport. */
export async function waitForProcessSaveSettled(page, timeoutMs = 10000) {
  await page.waitForFunction(() => [...document.querySelectorAll("section")].some(section =>
    [...section.querySelectorAll("h2")].some(h => h.textContent === "Process steps") &&
    [...section.querySelectorAll('[role="status"]')].some(s => s.textContent === "Process saved") &&
    [...section.querySelectorAll("button")].some(b => b.textContent === "Save process steps" && b.disabled)), undefined, { timeout: timeoutMs });
}
