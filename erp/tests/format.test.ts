import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "@/lib/format";

describe("formatMoney", () => {
  it.each([
    [0, "$0.00"],
    ["0", "$0.00"],
    [12, "$12.00"],
    ["12.5", "$12.50"],
    [1234567.89, "$1,234,567.89"],
    ["-1234.5", "-$1,234.50"],
    ["1.25e3", "$1,250.00"],
    ["1.005", "$1.01"],
  ])("formats the amount %j as %s", (value, expected) => {
    expect(formatMoney(value)).toBe(expected);
  });

  it("keeps four places for unit prices, including meaningful trailing zeros", () => {
    expect(formatMoney("1234.5678", 4)).toBe("$1,234.5678");
    expect(formatMoney("-12.3", 4)).toBe("-$12.3000");
    expect(formatMoney("0.12345", 4)).toBe("$0.1235");
    expect(formatMoney(0, 4)).toBe("$0.0000");
  });

  it.each([-0, "-0", "-0.0001"])("does not display signed zero for %j", (value) => {
    expect(formatMoney(value)).toBe("$0.00");
  });
});

describe("formatNumber", () => {
  it("groups counts without decimal places", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber("1234567")).toBe("1,234,567");
    expect(formatNumber(-1234)).toBe("-1,234");
  });

  it("keeps the specified display precision for weights, averages, and each-weight", () => {
    expect(formatNumber("1234.5", 2)).toBe("1,234.50");
    expect(formatNumber(12, 1)).toBe("12.0");
    expect(formatNumber("0.125", 4)).toBe("0.1250");
    expect(formatNumber("-1234.56789", 4)).toBe("-1,234.5679");
    expect(formatNumber(0, 2)).toBe("0.00");
    expect(formatNumber("1.25e3", 2)).toBe("1,250.00");
  });

  it("normalizes zero after rounding, while preserving a visible negative value", () => {
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber("-0.4")).toBe("0");
    expect(formatNumber("-0.004", 2)).toBe("0.00");
    expect(formatNumber("-0.006", 2)).toBe("-0.01");
  });
});

describe("missing or invalid numeric display values", () => {
  it.each([
    null, undefined, "", " ", "\t\n", " 12 ", "0x10", "0b10", "1,234.00", "$12.00",
    "12 apples", "NaN", "Infinity", "1e999", Number.NaN, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("renders %j as an em dash instead of a made-up zero", (value) => {
    expect(formatMoney(value)).toBe("—");
    expect(formatMoney(value, 4)).toBe("—");
    expect(formatNumber(value)).toBe("—");
    expect(formatNumber(value, 2)).toBe("—");
  });

  it("does not coerce values outside the numeric transport contract", () => {
    for (const value of [true, false, [], {}, { toString: () => "12" }]) {
      expect(formatMoney(value as unknown as number)).toBe("—");
      expect(formatNumber(value as unknown as number)).toBe("—");
    }
  });
});

describe("formatDate civil dates", () => {
  it.each([
    ["2026-09-11", "09/11/2026"],
    ["2026-01-05", "01/05/2026"],
    ["2024-02-29", "02/29/2024"],
    ["2000-02-29", "02/29/2000"],
    ["2026-12-31", "12/31/2026"],
  ])("displays %s as the same calendar day %s", (value, expected) => {
    expect(formatDate(value)).toBe(expected);
  });

  it.each([
    "2025-02-29", "1900-02-29", "2026-04-31", "2026-02-30", "2026-00-10",
    "2026-13-01", "2026-01-00", "2026-01-32", "2026-9-11", "09/11/2026",
    "2026/09/11", "2026-09", " 2026-09-11 ", "September 11, 2026",
  ])("rejects an invalid or non-ISO civil date %s", (value) => {
    expect(formatDate(value)).toBe("—");
  });
});

describe("invalid timestamp display values", () => {
  it.each([
    null, undefined, "", " ", "not-a-date", new Date(Number.NaN),
    "2026-02-30T12:00:00Z", "2025-02-29T12:00:00Z", "2026-09-11T24:00:00Z",
    "2026-09-11T12:60:00Z", "2026-09-11T12:00:60Z", "2026-09-11T12:00:00+24:00",
    "2026-09-11T12:00:00", " 2026-09-11T12:00:00Z ",
  ])("rejects %j without normalizing it to another date", (value) => {
    expect(formatDate(value)).toBe("—");
    expect(formatDateTime(value)).toBe("—");
  });

  it("does not invent a midnight timestamp for a civil date", () => {
    expect(formatDateTime("2026-09-11")).toBe("—");
  });
});

// A child process fixes TZ before the module (and its cached Intl instances) load. Changing
// process.env.TZ inside a shared Vitest worker would make this test affect unrelated tests.
const FORMAT_MODULE = new URL("../src/lib/format.ts", import.meta.url).href;
const timezoneProbe = `
  import { formatDate, formatDateTime } from ${JSON.stringify(FORMAT_MODULE)};
  const early = "2026-09-11T01:02:03.456Z";
  const late = new Date("2026-09-11T23:04:05.000Z");
  process.stdout.write(JSON.stringify({
    civil: formatDate("2024-02-29"),
    earlyDate: formatDate(early),
    earlyTime: formatDateTime(early),
    lateDate: formatDate(late),
    lateTime: formatDateTime(late),
    offsetTime: formatDateTime("2026-09-10T20:02:03-05:00"),
    midnight: formatDateTime("2026-09-11T00:00:00Z"),
    shortTime: formatDateTime("2026-09-11T01:02Z"),
  }));
`;

describe("local timestamp and timezone-independent civil-date display", () => {
  it.each([
    {
      zone: "UTC",
      expected: {
        civil: "02/29/2024",
        earlyDate: "09/11/2026", earlyTime: "09/11/2026, 1:02:03 AM",
        lateDate: "09/11/2026", lateTime: "09/11/2026, 11:04:05 PM",
        offsetTime: "09/11/2026, 1:02:03 AM", midnight: "09/11/2026, 12:00:00 AM",
        shortTime: "09/11/2026, 1:02:00 AM",
      },
    },
    {
      zone: "America/Chicago",
      expected: {
        civil: "02/29/2024",
        earlyDate: "09/10/2026", earlyTime: "09/10/2026, 8:02:03 PM",
        lateDate: "09/11/2026", lateTime: "09/11/2026, 6:04:05 PM",
        offsetTime: "09/10/2026, 8:02:03 PM", midnight: "09/10/2026, 7:00:00 PM",
        shortTime: "09/10/2026, 8:02:00 PM",
      },
    },
    {
      zone: "Pacific/Kiritimati",
      expected: {
        civil: "02/29/2024",
        earlyDate: "09/11/2026", earlyTime: "09/11/2026, 3:02:03 PM",
        lateDate: "09/12/2026", lateTime: "09/12/2026, 1:04:05 PM",
        offsetTime: "09/11/2026, 3:02:03 PM", midnight: "09/11/2026, 2:00:00 PM",
        shortTime: "09/11/2026, 3:02:00 PM",
      },
    },
  ])("uses $zone local time without shifting a date-only string", ({ zone, expected }) => {
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", timezoneProbe], {
      env: { ...process.env, TZ: zone },
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(JSON.parse(output)).toEqual(expected);
  });
});
