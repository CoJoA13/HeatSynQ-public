// The History panel's read is gated on the client before it is sent (#620): the route refuses it
// at `admin.view`, so a viewer without that permission used to pay one guaranteed 403 per
// detail-page mount and per write, and read "History could not be loaded." for a missing
// permission. The decision is a client-safe leaf so it can be pinned without a renderer, and
// mutation-proven: make every caller allowed and these red.
import { describe, expect, it } from "vitest";
import { historyAccess } from "@/lib/history-access";

describe("historyAccess (#620)", () => {
  it("is pending while the permission read is out, so nothing is sent and nothing flashes", () => {
    expect(historyAccess(undefined, null)).toEqual({ kind: "pending" });
  });

  it("is failed when the permission read failed: the panel keeps its failure sentence, not a denial", () => {
    expect(historyAccess(undefined, "Network error")).toEqual({ kind: "failed" });
  });

  it("is denied, with the gate's own title, when admin.view is not held", () => {
    expect(historyAccess([], null)).toEqual({ kind: "denied", title: "Requires admin.view" });
    expect(historyAccess(["orders.view", "admin.edit"], null)).toEqual({ kind: "denied", title: "Requires admin.view" });
  });

  it("is allowed when admin.view is held", () => {
    expect(historyAccess(["admin.view"], null)).toEqual({ kind: "allowed" });
    expect(historyAccess(["orders.view", "admin.view"], null)).toEqual({ kind: "allowed" });
  });

  it("a landed array wins over a stale error: the read answered after a retry", () => {
    expect(historyAccess(["admin.view"], "earlier failure")).toEqual({ kind: "allowed" });
  });
});
