import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { containerTagsData, type ContainerTagsOrder } from "@/server/container-tags";

// #743: the container tag's text. The mapping turns the order (one read, src/server/container-tags.ts)
// into one `ContainerTagData` per container row and the file's name; the builder
// (tests/container-tags-pdf.test.ts) only lays that text out. The received line is the owner's
// confirmation of 2026-10-23: the Received date, a civil date, then the time of day the order was
// created on the plant's clock (`PLANT_TIME_ZONE`).

function order(overrides: Partial<ContainerTagsOrder> = {}): ContainerTagsOrder {
  return {
    orderNumber: 1031, poNumber: "4500123",
    receivedDate: new Date("2026-10-23T00:00:00.000Z"),       // a date-only value: UTC midnight of its day
    createdAt: new Date("2026-10-23T14:02:59.999Z"),          // 9:02 AM at the plant (UTC-5 in October)
    customer: { name: "Acme Steel Inc" },
    lines: [
      { qty: 1000, part: { partNumber: "WIDGET-100" } },
      { qty: 20, part: { partNumber: "BRACKET-7" } },
    ],
    containers: [{ count: 2 }, { count: 3 }],
    ...overrides,
  };
}

describe("containerTagsData", () => {
  it("makes one tag per container row, each carrying the order, the customer, the PO, the parts with grouped quantities, the order's container total and the received line", () => {
    const { tags } = containerTagsData(order());
    expect(tags).toHaveLength(2);
    const expected = {
      orderNumber: "1031", customer: "Acme Steel Inc", poNumber: "4500123",
      parts: ["WIDGET-100 × 1,000", "BRACKET-7 × 20"], containersTotal: "5", received: "10/23/2026, 9:02 AM",
    };
    expect(tags).toEqual([expected, expected]);
  });

  it("prints the container total as every row's count added up, never the row's own count", () => {
    const { tags } = containerTagsData(order({ containers: [{ count: 1 }, { count: 4 }, { count: 2 }] }));
    expect(tags.map((t) => t.containersTotal)).toEqual(["7", "7", "7"]);
  });

  it("takes the date from the Received date and the time from the creation instant, so an order received a day before it was keyed says both", () => {
    const { tags } = containerTagsData(order({
      receivedDate: new Date("2026-10-22T00:00:00.000Z"),
      createdAt: new Date("2026-10-23T22:15:00.000Z"),  // 5:15 PM at the plant on the 23rd
    }));
    expect(tags[0].received).toBe("10/22/2026, 5:15 PM");
  });

  it("prints a blank PO as a dash", () => {
    expect(containerTagsData(order({ poNumber: "" })).tags[0].poNumber).toBe("—");
  });

  it("names the file by the order", () => {
    expect(containerTagsData(order()).fileName).toBe("container-tags-1031.pdf");
  });

  it("answers no tag for an order with no container rows; the route refuses that before any render", () => {
    expect(containerTagsData(order({ containers: [] })).tags).toEqual([]);
  });
});

// The zone proof, the register's shape (tests/invoice-register-pdf.test.ts): this laptop runs in the
// plant's own zone, so only a process in another zone shows a time not read in plant time, and only a
// zone west of UTC shows the Received date read on the process's clock instead of as the UTC midnight
// it is held as. tsx loads the mapping, which loads no database.
const MAPPING = new URL("../src/server/container-tags.ts", import.meta.url).href;
const plantProbe = `
  import { containerTagsData } from ${JSON.stringify(MAPPING)};
  const { tags } = containerTagsData({
    orderNumber: 1, poNumber: "", receivedDate: new Date("2026-10-21T00:00:00.000Z"),
    createdAt: new Date("2026-10-21T03:00:00.000Z"),
    customer: { name: "C" }, lines: [], containers: [{ count: 1 }],
  });
  process.stdout.write(JSON.stringify(tags[0].received));
`;
describe("containerTagsData on the plant's clock", () => {
  it.each(["UTC", "Asia/Tokyo", "America/Los_Angeles"])("reads the time in plant time and the date as held, in a process running in %s", (zone) => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", plantProbe], {
      env: { ...process.env, TZ: zone }, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
    });
    // 10:00 PM on the 20th at the plant, printed beside the Received date of the 21st as held.
    expect(JSON.parse(output)).toBe("10/21/2026, 10:00 PM");
  }, 20_000);
});
