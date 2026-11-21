import { describe, it, expect } from "vitest";
import { gate, gateDo, permissionsPending } from "@/lib/permission-ui";

describe("permission UI gating", () => {
  it("allows what the user holds", () => {
    expect(gate(["customers.delete"], "customers.delete"))
      .toEqual({ allowed: true, disabled: false, title: undefined });
  });

  it("disables and names the missing permission rather than hiding the control", () => {
    // A hidden button is a block with no explanation: the user cannot tell whether the action is
    // missing, broken, or forbidden, and has nothing to ask for.
    expect(gate(["customers.view"], "customers.delete"))
      .toEqual({ allowed: false, disabled: true, title: "Requires customers.delete" });
  });

  it("keys special actions under action.<name>, matching /api/auth/me", () => {
    expect(gateDo(["action.change_prices"], "change_prices").allowed).toBe(true);
    expect(gateDo([], "change_prices"))
      .toEqual({ allowed: false, disabled: true, title: "Requires change_prices" });
  });

  it("treats an absent permission array as no permissions, not as full access", () => {
    // /api/auth/me can be in flight on first render. Failing open would flash live controls.
    expect(gate(undefined, "customers.delete").allowed).toBe(false);
  });
});

describe("permissionsPending: the beat before /api/auth/me answers (#483)", () => {
  it("is pending while the read is in flight: no array and no error", () => {
    expect(permissionsPending(undefined, null)).toBe(true);
  });

  it("is not pending once an array has landed, an empty one included", () => {
    expect(permissionsPending([], null)).toBe(false);
    expect(permissionsPending(["shipping.view"], null)).toBe(false);
  });

  it("is not pending once the read has failed, so a page waiting on it renders with its banner", () => {
    // The #483 ruling: if /api/auth/me fails, the saved shipment page renders as it did before,
    // with the error in its banner, rather than holding on "Loading…" for good.
    expect(permissionsPending(undefined, "Request failed (500)")).toBe(false);
  });
});
