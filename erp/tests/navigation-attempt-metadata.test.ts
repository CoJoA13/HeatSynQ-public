import { expect, it, vi } from "vitest";
import { createNavigationAttempts } from "../src/lib/navigation-attempts";
import type { DiscardIntent } from "../src/lib/draft-navigation";

it("owns exact stamp metadata at capture before a destination or prompt exists", () => {
  const owner = { userId: "original-user", authGeneration: 3 };
  const selected = { key: { owner, record: { kind: "order", id: "original-order" }, editor: "serials", childId: "line-a", entityVersion: "v1" }, generation: 7, version: 2 };
  const stamps = [selected];
  const expected = structuredClone({ owner, stamps });
  const intents = { prepare: vi.fn((_intent: DiscardIntent) => { void _intent; }), attach: vi.fn(), consume: vi.fn(() => []), invalidate: vi.fn() };
  const holder = createNavigationAttempts(intents);
  const attempt = holder.capture({ owner, stamps });
  owner.userId = "changed-user"; owner.authGeneration = 4;
  selected.key.record.id = "different-order"; selected.key.childId = "line-b";
  selected.key.entityVersion = "v2"; selected.generation = 8; selected.version = 3;
  stamps.length = 0;
  expect(attempt.attach("/destination")).toBe(true);
  expect(intents.prepare).toHaveBeenCalledExactlyOnceWith({ operationId: expect.any(String), ...expected, destination: "/destination" });
  expect(intents.consume).not.toHaveBeenCalled();
});
