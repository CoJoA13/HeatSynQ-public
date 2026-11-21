import { describe, expect, it } from "vitest";
import { unreadReason, waitForTitle } from "../e2e/lib/ui.mjs";

// `waitForTitle` (e2e/lib/ui.mjs) is what a flow's title assertion rests on since #472: a flow
// waits with it for a greyed control to carry the server's sentence. A helper that returned early
// would turn every one of those assertions into a pass that proves nothing, and no browser run
// would show it. So its three answers are proven here, against a stand-in for a Playwright locator.

/** Each read takes the next answer, and the last answer repeats. An Error is thrown, the way a
 *  locator rejects. `asked` records what each read asked for: the attribute's name, then the
 *  options. The answers do not depend on the name, so a case that cares which attribute was read
 *  asserts `asked`. */
function titles(...answers: (string | null | Error)[]) {
  const asked: unknown[][] = [];
  let read = 0;
  return {
    asked,
    getAttribute: async (...args: unknown[]) => {
      asked.push(args);
      const answer = answers[Math.min(read++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

/** What a Playwright locator rejects with while its element is not on the page: the read's own
 *  timeout runs out, and the error is named `TimeoutError`. */
const notAttached = () => Object.assign(new Error("locator.getAttribute: Timeout 1000ms exceeded."), { name: "TimeoutError" });
/** A rejection that is not a timeout: the locator matches two elements. Playwright rejects this
 *  read at once, with a plain Error. */
const TWO_MATCH = "locator.getAttribute: Error: strict mode violation: " +
  "getByRole('button', { name: 'Remove order' }) resolved to 2 elements";

const FROZEN =
  "This shipment cannot be changed — Invoice 300 is finalized; unlock it or raise a credit (see /invoicing/inv-1)";

describe("waitForTitle (e2e/lib/ui.mjs)", () => {
  it("waits past the titles a gate shows first, for the string it was asked for", async () => {
    const control = titles("Requires shipping.edit", "Resolve draft recovery before editing.", FROZEN);
    await waitForTitle(control, FROZEN, "a Lines input");
    // Three reads. A helper that returned on either title a gate shows first would have made fewer.
    expect(control.asked).toHaveLength(3);
  });

  it("reads the `title` attribute on every poll, and no other", async () => {
    const control = titles("Requires shipping.edit", FROZEN);
    await waitForTitle(control, FROZEN, "a Lines input");
    expect(control.asked.map(([name]) => name)).toEqual(["title", "title"]);
    // A wait for no title is the one a wrong name would pass in a browser: an attribute the
    // element does not carry reads null.
    const untitled = titles(null);
    await waitForTitle(untitled, null, "Route");
    expect(untitled.asked.map(([name]) => name)).toEqual(["title"]);
  });

  it("takes a RegExp, and a title that never matches it fails", async () => {
    await waitForTitle(titles("Requires shipping.edit", FROZEN), /^This shipment cannot be changed — Invoice 300 /, "a Lines input");
    await expect(waitForTitle(titles(null), /Invoice/, "a Lines input", 300)).rejects.toMatchObject({
      code: "ERR_ASSERTION",
      message: "Timed out waiting for a Lines input to carry the title /Invoice/; last read null",
    });
  });

  it("fails through node:assert, naming the control and the last title read", async () => {
    await expect(waitForTitle(titles("Requires shipping.edit"), FROZEN, "a Lines input", 300)).rejects.toMatchObject({
      code: "ERR_ASSERTION",
      message: `Timed out waiting for a Lines input to carry the title ${FROZEN}; last read "Requires shipping.edit"`,
    });
  });

  it("takes null for no title: an element that carries none, never an element that is missing", async () => {
    await waitForTitle(titles(notAttached(), "Requires shipping.edit", null), null, "Route");
    await expect(waitForTitle(titles("Requires shipping.edit"), null, "Route", 300)).rejects.toMatchObject({
      code: "ERR_ASSERTION",
      message: 'Timed out waiting for Route to carry no title; last read "Requires shipping.edit"',
    });
    await expect(waitForTitle(titles(notAttached()), null, "Route", 300)).rejects.toMatchObject({
      code: "ERR_ASSERTION",
      message: "Timed out waiting for Route to carry no title; last read nothing (the element could not be read)",
    });
  });

  it("names the cause when a read is rejected for a reason that is not a timeout", async () => {
    // Two elements match. Folded into "could not be read", this cost a full timeout and hid why.
    await expect(waitForTitle(titles(new Error(TWO_MATCH)), FROZEN, "Remove order", 300)).rejects.toMatchObject({
      code: "ERR_ASSERTION",
      message: `Timed out waiting for Remove order to carry the title ${FROZEN}; last read nothing (the read was rejected: ${TWO_MATCH})`,
    });
    // Nor is a rejected read ever "no title".
    await expect(waitForTitle(titles(new Error(TWO_MATCH)), null, "Remove order", 300)).rejects.toMatchObject({
      code: "ERR_ASSERTION",
      message: `Timed out waiting for Remove order to carry no title; last read nothing (the read was rejected: ${TWO_MATCH})`,
    });
    // The cause named is the last read's: a rejection the page got past is not blamed.
    await expect(waitForTitle(titles(new Error(TWO_MATCH), "Requires shipping.edit"), FROZEN, "Remove order", 300))
      .rejects.toMatchObject({
        message: `Timed out waiting for Remove order to carry the title ${FROZEN}; last read "Requires shipping.edit"`,
      });
  });

  it("keeps polling past a rejected read: one that does not last costs nothing", async () => {
    // A read can be rejected for a beat, by a navigation in flight for one. Only a rejection that
    // is still there at the deadline fails the wait.
    const control = titles(new Error("locator.getAttribute: Execution context was destroyed"), FROZEN);
    await waitForTitle(control, FROZEN, "a Lines input");
    expect(control.asked).toHaveLength(2);
  });
});

// `unreadReason` is the words `waitForTitle` gives a rejected read. It is exported because a flow
// that polls another read of a locator (the strip of order quantities, in
// e2e/flows/hub-line-corrections.mjs) must say the same thing: a poll that reads every rejection
// as "nothing there" fails with the wrong cause when two elements match.
describe("unreadReason (e2e/lib/ui.mjs)", () => {
  it("reads a read's own timeout as an element that is not on the page", () => {
    expect(unreadReason(notAttached())).toBe("the element could not be read");
  });

  it("names any other rejection by its own message", () => {
    expect(unreadReason(new Error(TWO_MATCH))).toBe(`the read was rejected: ${TWO_MATCH}`);
    expect(unreadReason(new Error("locator.textContent: Target page, context or browser has been closed")))
      .toBe("the read was rejected: locator.textContent: Target page, context or browser has been closed");
    // A rejection need not be an Error.
    expect(unreadReason("gone")).toBe("the read was rejected: gone");
    expect(unreadReason(undefined)).toBe("the read was rejected: undefined");
  });
});
