import { expect, it } from "vitest";
import { createDiscardIntents } from "../src/lib/draft-navigation";
import type { Owner, Stamp } from "../src/lib/draft-store";

const owner: Owner = { userId: "same-user", authGeneration: 7 };
function stamp(authGeneration: number, childId?: string, entityVersion?: string): Stamp {
  return { key: { owner: { userId: owner.userId, authGeneration }, record: { kind: "template", id: "template-a" }, editor: "template-editor",
    ...(childId === undefined ? {} : { childId }), ...(entityVersion === undefined ? {} : { entityVersion }) }, generation: 11, version: 3 };
}
it("excludes a different auth generation even when the user ID is identical", () => {
  const ledger = createDiscardIntents(), current = stamp(7), previous = stamp(6);
  ledger.prepare({ operationId: "leave", owner, stamps: [previous, current], destination: "/templates" });
  ledger.attach("leave", "/templates");
  expect(ledger.consume("leave", "/templates")).toEqual([current]);
});

it("owns and returns exact optional child and entity-version identity without merging siblings", () => {
  const ledger = createDiscardIntents();
  const captured = stamp(7, "step-a", "draft-2"), sibling = stamp(7, "step-b", "draft-2"), older = stamp(7, "step-a", "draft-1");
  const supplied = { ...captured, key: { ...captured.key, childId: "step-a", entityVersion: "draft-2" } };
  ledger.prepare({ operationId: "leave", owner, stamps: [supplied, sibling, older], destination: "/templates" });
  supplied.key.childId = "changed-child"; supplied.key.entityVersion = "changed-version";
  ledger.attach("leave", "/templates");
  expect(ledger.consume("leave", "/templates")).toEqual([captured, sibling, older]);
  expect(ledger.consume("leave", "/templates")).toEqual([]);
});
