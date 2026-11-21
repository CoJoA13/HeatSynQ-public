// The app's one modal (src/lib/modal.ts, src/components/ModalHost.tsx; ruling 5 of 2026-10-30): how
// a flow answers a page that asks through it. A flow calls `answerModal` AFTER the click that
// raises the dialog (the dialog is in the DOM, so there is no one-shot listener to arm first): it
// waits for the open <dialog>, types the reason when given, and presses the confirm (the dialog's
// last button) or Cancel. `modalTitle` and `modalBody` read the heading and a confirm's sentence for
// an assertion, and `waitForModal` fails in the caller's words on a click that raised none. Swept
// suite source: no routing, no raw requests, assertions through node:assert.
import assert from "node:assert/strict";

/** The open modal: a <dialog> with the `open` attribute. */
function openModal(page) {
  return page.locator("dialog[open]");
}

/** Waits for the modal; a click that raised none fails here with `mustAsk`. */
export async function waitForModal(page, mustAsk, timeout = 5000) {
  await openModal(page).waitFor({ state: "visible", timeout }).catch(() => assert.fail(mustAsk));
}

export async function modalTitle(page) {
  const dialog = openModal(page);
  await dialog.waitFor({ state: "visible" });
  return (await dialog.getByRole("heading").first().textContent()) ?? "";
}

/** A confirm's sentence under its title; "" when it has none. */
export async function modalBody(page) {
  const dialog = openModal(page);
  await dialog.waitFor({ state: "visible" });
  return (await dialog.locator("p").first().textContent({ timeout: 1000 }).catch(() => "")) ?? "";
}

/**
 * Answer the open modal. `reason` fills the reason box (a reason dialog); `confirm: false`
 * presses Cancel. Resolves once the dialog has closed, so the caller's next step sees the answer
 * applied rather than the dialog still up.
 */
export async function answerModal(page, { reason, confirm = true } = {}) {
  const dialog = openModal(page);
  await dialog.waitFor({ state: "visible" });
  if (reason !== undefined) {
    const box = dialog.getByRole("textbox");
    await box.fill(reason);
  }
  const buttons = dialog.getByRole("button");
  const count = await buttons.count();
  assert.ok(count >= 2, "the modal offers Cancel and a confirm");
  if (confirm) await buttons.nth(count - 1).click();
  else await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

/** Type into Set password's box and press its button. The dialog stays open on a refusal, so the
 *  caller waits on what it expects: the refusal, or the dialog closing. */
export async function fillPasswordModal(page, password) {
  const dialog = openModal(page);
  await dialog.waitFor({ state: "visible" });
  await dialog.getByLabel("New password", { exact: true }).fill(password);
  await dialog.getByRole("button", { name: "Set password", exact: true }).click();
}
