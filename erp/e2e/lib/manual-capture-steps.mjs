// The capture tool's three steps. Two are the weights design's §14.2 ("The capture tool"): the one
// container row of the order-entry pictures, and Pick lists with Container types chosen. The third
// is its §15.2: the wait for the draft's status word before the first order-entry picture. They live
// here, and not in e2e/manual-capture.mjs, because that file starts a server when it is imported,
// so no test could run them there. tests/manual-capture-steps.test.ts runs each branch over a
// stand-in page. Only a run of the tool shows them against the app.
//
// This file is a swept suite source, as e2e/lib/manual-backup-folder.mjs is.
//
// What the steps promise the tool:
//   * `watchOfferedTypes`, `keyContainerRow` and `waitForDraftSaved` never reject. A row that could
//     not be keyed, or a status word that did not show, is a note in the report and never an error
//     on the picture's row, so the pictures after it are still taken.
//   * No step presses a save control. `showContainerTypes` types in no box: a Tare each box on
//     Pick lists saves when it is left. `waitForDraftSaved` presses and types nothing.
import { waitForValue } from "./ui.mjs";

/** The one container row of the order-entry pictures (the owner's answer 4 of 2026-10-12). */
export const CONTAINER_ROW = Object.freeze({ typeName: "Steel Basket", count: "3", pieces: "30" });

/**
 * The report's lines: the design's §14.3, its §14.7, point 28, and for `draftNotSaved` its §15.3,
 * line L5. In the report `takenOut`, `notTakenOut` and `notAdded` are followed by a colon and the
 * error's text.
 */
export const CAPTURE_WORDS = Object.freeze({
  filledWithRow: "Order entry with a customer, a part line and a container row filled in",
  keyed: "container row: 3 × Steel Basket, 30 pieces, Tare each as the type fills it",
  notOffered: "no container type named Steel Basket is offered on this screen, so no container row was keyed",
  noTareEach: "Steel Basket carries no Tare each on this database, so the row's Tare each box was left empty",
  containerTypes: "Pick lists with Container types chosen",
  noRows: "the Container types list showed no row within the wait, so the picture may show an empty table",
  takenOut: "the container row could not be keyed and was taken out again",
  notSeen: "the screen's read of its container types was not seen within the wait, so no container row was keyed",
  notTakenOut: "the container row could not be keyed and could not be taken out again, so the pictures may show it",
  notAdded: "Add container could not be pressed, so no container row was keyed",
  draftNotSaved: "the draft's status did not read Draft saved within the wait, so the pictures show the header as it stood",
});

/** The new picture's name, without its ending. */
export const CONTAINER_TYPES_SHOT = "interaction-admin-reference-container-types";

/** Order entry's own read of the container types, and the Pick lists table's read of that list. */
const OFFERED_TYPES_PATH = "/api/picklists/containerType";
const LISTED_TYPES_PATH = "/api/admin/reference/containerType";
/** How long one press, pick or fill of the row may take. The tool's own limit for one is longer. */
const ACTION_TIMEOUT_MS = 10000;
/** A loaded row of the Container types list has a box named for the row, `Tare each (lb) for <name>`
 *  (ReferenceTable.tsx). The add row's box is not named for a row. */
const LOADED_ROW_BOX = /^Tare each \(lb\) for /;

/** Tells a good answer to the page's own GET of `pathname` from every other answer. An answer
 *  whose address cannot be read is not it. */
function answersGet(pathname) {
  return (response) => {
    try {
      return new URL(response.url()).pathname === pathname
        && response.request().method() === "GET" && response.ok();
    } catch {
      return false;
    }
  };
}

/** An error as the tool's report spells one. */
const errorText = (error) => String(error?.message ?? error);

/**
 * Arms a wait for the screen's own read of the container types. Called before the page is opened.
 * The function it returns resolves with the rows read, or with null when no answer was seen in time
 * or it could not be read. Neither it nor the wait ever rejects.
 */
export function watchOfferedTypes(page, timeoutMs = 15000) {
  let rows;
  try {
    rows = Promise.resolve(page.waitForResponse(answersGet(OFFERED_TYPES_PATH), { timeout: timeoutMs }))
      .then((response) => response.json())
      .then((body) => (Array.isArray(body) ? body : null))
      .catch(() => null);
  } catch {
    rows = Promise.resolve(null);
  }
  return () => rows;
}

/** The Remove of container row 1: the one in the nearest block round the row's Type list that
 *  holds a button of that name, which is the row's own block (EntryContainerRow.tsx). */
function rowRemove(page) {
  return page.getByLabel("Container 1 type", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Remove']][1]")
    .getByRole("button", { name: "Remove", exact: true });
}

/**
 * Keys the row, or does not, as the design's §14.2 says. Never rejects. `keyed` is true only when
 * the row is on the form, complete.
 *
 * `offered` is what `watchOfferedTypes` resolved with. The type is looked for there first, because
 * the Type list exists only inside an added row. Nothing is typed in Tare each: a type that carries
 * one fills the box, as `String` of the figure (`tareEachText` in src/lib/container-tare-prefill.ts),
 * and the step waits for that. Whatever fails once the row is on the form, the row's Remove is
 * pressed, so that no half-keyed row is in a picture. When that press fails too, the row may be
 * in the pictures, and the note says so.
 */
export async function keyContainerRow(page, offered) {
  if (!Array.isArray(offered)) return { keyed: false, notes: [CAPTURE_WORDS.notSeen] };
  const type = offered.find((row) => row?.name === CONTAINER_ROW.typeName);
  if (!type) return { keyed: false, notes: [CAPTURE_WORDS.notOffered] };
  let added = false;
  try {
    await page.getByRole("button", { name: "Add container", exact: true }).click({ timeout: ACTION_TIMEOUT_MS });
    added = true;
    await page.getByLabel("Container 1 type", { exact: true }).selectOption(type.id, { timeout: ACTION_TIMEOUT_MS });
    await page.getByLabel("Container 1 count", { exact: true }).fill(CONTAINER_ROW.count, { timeout: ACTION_TIMEOUT_MS });
    await page.getByLabel("Container 1 pieces", { exact: true }).fill(CONTAINER_ROW.pieces, { timeout: ACTION_TIMEOUT_MS });
    if (type.tareEach === null || type.tareEach === undefined) {
      return { keyed: true, notes: [CAPTURE_WORDS.noTareEach] };
    }
    await waitForValue(page.getByLabel("Container 1 tare each", { exact: true }), String(type.tareEach), ACTION_TIMEOUT_MS);
    return { keyed: true, notes: [CAPTURE_WORDS.keyed] };
  } catch (error) {
    const why = errorText(error);
    if (!added) return { keyed: false, notes: [`${CAPTURE_WORDS.notAdded}: ${why}`] };
    try {
      await rowRemove(page).click({ timeout: ACTION_TIMEOUT_MS });
      return { keyed: false, notes: [`${CAPTURE_WORDS.takenOut}: ${why}`] };
    } catch {
      return { keyed: false, notes: [`${CAPTURE_WORDS.notTakenOut}: ${why}`] };
    }
  }
}

/**
 * On Pick lists: arms the wait for the list's read, presses "Container types", and waits for a
 * loaded row's box. Types in no box. The table draws its heading and its add row before its rows
 * land, so without the two waits the picture could be of an empty table. A press that fails
 * rejects, and the tool marks the picture's row. No row within the wait is a note.
 */
export async function showContainerTypes(page, timeoutMs = 10000) {
  // Handled where it is made: whether the read was seen decides nothing, the box below does.
  const read = Promise.resolve(page.waitForResponse(answersGet(LISTED_TYPES_PATH), { timeout: timeoutMs }))
    .then(() => true, () => false);
  await page.getByRole("button", { name: "Container types", exact: true }).click({ timeout: timeoutMs });
  await read;
  const loaded = await page.getByLabel(LOADED_ROW_BOX).first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true, () => false);
  return { notes: loaded ? [] : [CAPTURE_WORDS.noRows] };
}

/** The word order entry's header shows once the draft is stored (DraftSaveStatus, EntryWorkspace.tsx). */
export const DRAFT_SAVED_WORD = "Draft saved";

/**
 * Waits until the page shows that word, as its exact text, for at most `timeoutMs`. Presses and
 * types nothing. Never rejects. `saved` is false, with the report's one line, when the wait runs
 * out or fails, or when the page cannot be asked. The tool goes on either way.
 */
export async function waitForDraftSaved(page, timeoutMs = 10000) {
  try {
    await page.getByText(DRAFT_SAVED_WORD, { exact: true }).waitFor({ state: "visible", timeout: timeoutMs });
    return { saved: true, notes: [] };
  } catch {
    return { saved: false, notes: [CAPTURE_WORDS.draftNotSaved] };
  }
}
