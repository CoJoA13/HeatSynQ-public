import { expect, it } from "vitest";
import { unknownFixture } from "./helpers/unknown-retention";
import { runNewShipmentSave, runNewShipmentRetry, prepareNewShipmentSave } from "../src/lib/new-shipment-recovery";
import type { NewShipmentDraft, NewShipmentBaseline, ShipmentBody } from "../src/lib/new-shipment-recovery";
import type { Submission } from "../src/lib/draft-store";

type Token = Submission<NewShipmentDraft, NewShipmentBaseline, ShipmentBody>;
it("256 explicit unknown retries preserve exact original nonce/body and ignore settled earlier callbacks", async () => {
  const submissions: Token[] = []; const h = unknownFixture(s => submissions.push(s));
  let writes = 0; let original: ShipmentBody | undefined;
  const write = async (body: ShipmentBody): Promise<never> => { writes++; original ??= body; expect(body).toBe(original); throw new TypeError("controlled lost acknowledgement"); };
  await runNewShipmentSave({ binding: h.binding, requestId: "original", write, persisted: () => {} });
  const originalText = JSON.stringify(original); expect(writes).toBe(1);
  expect(original?.clientRequestId).toBe("3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e");
  expect(submissions[0].submitted.data.comments).toBe("  original raw notes  ");
  for (let i = 0; i < 256; i++) {
    const readId = h.refresh(); const view = h.binding.getSnapshot(); expect(view.canRetryUnknown).toBe(true);
    await runNewShipmentRetry({ binding: h.binding, stamp: view.current!.stamp, readId, requestId: `retry-${i}`, write, persisted: () => {} });
    expect(h.binding.getSnapshot().completed).toBeUndefined(); expect(h.store.getSnapshot().count).toBe(1);
  }
  expect(writes).toBe(257); expect(submissions).toHaveLength(257); expect(JSON.stringify(original)).toBe(originalText);
  const before = h.binding.getSnapshot();
  h.binding.settle(submissions[0], { kind: "persisted", response: { shipper: { id: "obsolete", shipperNumber: 1 }, warnings: [] } });
  expect(h.binding.getSnapshot()).toBe(before);
  const readId = h.refresh(); const view = h.binding.getSnapshot();
  await runNewShipmentRetry({ binding: h.binding, stamp: view.current!.stamp, readId, requestId: "final", write: async body => {
    expect(body).toBe(original); return { shipper: { id: "actual-created", shipperNumber: 702 }, warnings: ["Actual warning"] };
  }, persisted: () => {} });
  expect(h.binding.getSnapshot().completed).toEqual({ id: "actual-created", shipperNumber: 702, warnings: ["Actual warning"] });
  const final = h.binding.getSnapshot(); for (const old of submissions.slice(0, -1)) h.binding.settle(old, { kind: "unknown" });
  expect(h.binding.getSnapshot()).toBe(final);
});
it("a still-pending earlier submission keeps its actual outcome authority after a later unknown settlement", () => {
  const h = unknownFixture();
  const prepared = prepareNewShipmentSave(h.binding, "earlier-pending");
  expect(prepared.kind).toBe("ready"); if (prepared.kind !== "ready") throw new Error("Fixture must pass actual payload validation");
  const a = prepared.submission; expect(h.binding.dispatched(a)).toBe(true);
  const b = h.binding.capture(a.payload, "later-pending"); expect(h.binding.dispatched(b)).toBe(true);
  h.binding.settle(b, { kind: "unknown" });
  expect(h.binding.getSnapshot().completed).toBeUndefined();
  h.binding.settle(a, { kind: "persisted", response: { shipper: { id: "earlier-created", shipperNumber: 703 }, warnings: ["Keep late warning"] } });
  expect(h.binding.getSnapshot().completed?.id).toBe("earlier-created");
  const completed = h.binding.getSnapshot(); h.binding.settle(b, { kind: "persisted", response: { shipper: { id: "obsolete", shipperNumber: 704 }, warnings: [] } });
  expect(h.binding.getSnapshot()).toBe(completed);
});
