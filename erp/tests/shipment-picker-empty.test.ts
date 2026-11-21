import { describe, expect, it } from "vitest";
import { pickerEmptySentence } from "@/lib/shipment-gates";

// #698 (G8-4): an order with no container rows showed "Every order container is on this shipment"
// beside the disabled picker, which is true of zero rows and says nothing an operator can act on.
// The sentence is chosen here: the order has none, so add them on the order first; otherwise the
// old sentence word for word (an E2E flow pins it). The permission and access sentences stay ahead
// of both in the views (`emptyReason ??`). Mutation: return the old sentence for a has-none order.
describe("pickerEmptySentence", () => {
  it("names the order's grid when the order has no rows of that kind", () => {
    expect(pickerEmptySentence("container", true)).toBe("This order has no container rows. Add them on the order's Containers grid first.");
    expect(pickerEmptySentence("serial", true)).toBe("This order has no serials. Add them on the order's Serials grid first.");
  });

  it("keeps the old sentence, word for word, when every row of the order is on the shipment", () => {
    expect(pickerEmptySentence("container", false)).toBe("Every order container is on this shipment");
    expect(pickerEmptySentence("serial", false)).toBe("Every order serial is on this shipment");
    expect(pickerEmptySentence("line", false)).toBe("Every order line is on this shipment");
  });
});
