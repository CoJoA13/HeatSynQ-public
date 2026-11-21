import { expect, it } from "vitest";
import { unknownFixture } from "./helpers/unknown-retention";
import { prepareNewShipmentSave } from "../src/lib/new-shipment-recovery";

it("unknown retry keeps the earliest captured root when another unknown root interleaves", () => {
  const h = unknownFixture();
  const first = prepareNewShipmentSave(h.binding, "root-A");
  expect(first.kind).toBe("ready"); if (first.kind !== "ready") throw new Error("Actual first payload must validate");
  expect(h.binding.dispatched(first.submission)).toBe(true);
  h.binding.change(d => ({ ...d, comments: "  later independent body B  " }));
  const second = prepareNewShipmentSave(h.binding, "root-B");
  expect(second.kind).toBe("ready"); if (second.kind !== "ready") throw new Error("Actual second payload must validate");
  expect(h.binding.dispatched(second.submission)).toBe(true);
  expect(second.submission.payload).not.toBe(first.submission.payload);
  h.binding.settle(second.submission, { kind: "unknown" });
  h.binding.settle(first.submission, { kind: "unknown" });
  for (let i = 0; i < 8; i++) {
    const readId = h.refresh(); const stamp = h.binding.getSnapshot().current!.stamp;
    const retry = h.binding.prepareUnknownRetry(stamp, readId, `A-retry-${i}`);
    expect(retry).not.toBeNull(); if (!retry) throw new Error("Explicit retry must remain available");
    expect(retry.payload).toBe(first.submission.payload);
    expect(retry.submitted).toBe(first.submission.submitted);
    expect(retry.payload.comments).toBe("  original raw notes  ");
    expect(h.binding.dispatched(retry)).toBe(true);
    h.binding.settle(retry, { kind: "unknown" });
  }
  const before = h.binding.getSnapshot();
  h.binding.settle(second.submission, { kind: "persisted", response: { shipper: { id: "obsolete-B", shipperNumber: 9 }, warnings: [] } });
  expect(h.binding.getSnapshot()).toBe(before);
  expect(before.completed).toBeUndefined();
});

it("a pruned original request ID can be reused without reviving its obsolete exact submission", () => {
  const h = unknownFixture();
  const prepared = prepareNewShipmentSave(h.binding, "root-A");
  expect(prepared.kind).toBe("ready"); if (prepared.kind !== "ready") throw new Error("Actual payload must validate");
  const original = prepared.submission;
  expect(h.binding.dispatched(original)).toBe(true); h.binding.settle(original, { kind: "unknown" });
  let readId = h.refresh();
  const successor = h.binding.prepareUnknownRetry(h.binding.getSnapshot().current!.stamp, readId, "successor");
  expect(successor).not.toBeNull(); if (!successor) throw new Error("First retry must be admitted");
  expect(h.binding.dispatched(successor)).toBe(true); h.binding.settle(successor, { kind: "unknown" });
  readId = h.refresh(); const stamp = h.binding.getSnapshot().current!.stamp;
  const reused = h.binding.prepareUnknownRetry(stamp, readId, "root-A");
  expect(reused).not.toBeNull(); if (!reused) throw new Error("Settled pruned request ID must be reusable");
  expect(reused).not.toBe(original); expect(reused.payload).toBe(original.payload); expect(reused.submitted).toBe(original.submitted);
  expect(h.binding.prepareUnknownRetry(stamp, readId, "root-A")).toBeNull();
  expect(h.binding.dispatched(original)).toBe(false); expect(h.binding.dispatched(reused)).toBe(true);
  const pending = h.binding.getSnapshot();
  h.binding.settle(original, { kind: "persisted", response: { shipper: { id: "obsolete-original", shipperNumber: 1 }, warnings: [] } });
  h.binding.settle(original, { kind: "unknown" });
  expect(h.binding.getSnapshot()).toBe(pending);
  expect(h.binding.prepareUnknownRetry(stamp, readId, "another")).toBeNull();
  h.binding.settle(reused, { kind: "persisted", response: { shipper: { id: "rightful", shipperNumber: 2 }, warnings: [] } });
  expect(h.binding.getSnapshot().completed?.id).toBe("rightful");
  const completed = h.binding.getSnapshot(); h.binding.settle(successor, { kind: "unknown" });
  expect(h.binding.getSnapshot()).toBe(completed);
});
