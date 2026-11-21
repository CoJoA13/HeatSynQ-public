import { describe, expect, it } from "vitest";
import { fixtureRuntime } from "./helpers/e2e-fixture-bridge-runtime";

const controls = ["Save containers", "Save charges", "Save serials", "Finalize invoice", "Add payment", "Save quote"];

describe("actual setup response waiters have immediate failure ownership", () => {
  for (const name of controls) {
    it.each([
      { mode: "click" as const, label: "click fails before response" },
      { mode: "response" as const, label: "context closes and rejects response" },
      { mode: "after-response" as const, label: "response succeeds before UI continuation fails" },
    ])(`${name}: $label preserves the UI/transport error with an already joined waiter`, async ({ mode }) => {
      const error = new Error(mode === "response" ? "Target page, context or browser has been closed" : "fixture UI continuation failed");
      const runtime = fixtureRuntime({ failAt: name, mode, error });
      let caught: unknown;
      try { await runtime.run(); } catch (failure) { caught = failure; }
      // Simulate the following harness context closure. Internal fake transport promises are
      // suppressed so this intentional RED cannot crash Vitest via an unhandled rejection.
      runtime.rejectPending(new Error("context subsequently closed"));
      await Promise.resolve();
      expect(caught).toBe(error);
      expect(runtime.boundary.find(boundary => boundary.name === name)?.handled).toBe(true);
      expect(runtime.ctx.fixtures.draftRecovery).toBeUndefined();
      expect(runtime.owned.phase).toBe("setting-up");
      expect(runtime.ctx.created.receivablesBatchId).toBe("other-batch");
    });
  }

  it("a successful actual order response is recorded before a later UI continuation throws", async () => {
    const error = new Error("order hub continuation failed");
    const runtime = fixtureRuntime({ orderContinuationError: error });
    await expect(runtime.run()).rejects.toBe(error);
    expect(runtime.owned.ids).toEqual([{ kind: "order", id: "order-1" }]);
    expect(runtime.watchers[0].handled).toBe(true);
    expect(runtime.ctx.fixtures.draftRecovery).toBeUndefined();
  });

  it("successful setup joins every actual waiter, captures roots and publishes the complete real descriptor", async () => {
    const runtime = fixtureRuntime();
    const result = await runtime.run();
    expect(runtime.owned.phase).toBe("ready");
    expect(runtime.ctx.fixtures.draftRecovery).toBe(result);
    expect(runtime.owned.ids).toEqual(expect.arrayContaining([
      { kind: "order", id: "order-1" }, { kind: "shipment", id: "shipment-2" },
      { kind: "invoice", id: "invoice-1" }, { kind: "receipt-batch", id: "batch-1" },
      { kind: "payment", id: "payment-1" }, { kind: "quote", id: "quote-1" },
      { kind: "cert", id: "cert-1" },
      { kind: "part-field-def", id: "field-1" }, { kind: "part-field-def", id: "field-2" },
      { kind: "part-field-def", id: "field-3" }, { kind: "document-template", id: "document-1" },
    ]));
    expect(runtime.boundary.every(boundary => boundary.handled)).toBe(true);
    expect(runtime.ctx.created.receivablesBatchId).toBe("other-batch");
  });
});
