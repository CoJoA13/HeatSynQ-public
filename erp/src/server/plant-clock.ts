// Date and time as paper prints them: a civil date as MM/DD/YYYY, and an instant on the plant's
// clock (`PLANT_TIME_ZONE`, the build stamp's zone), whatever zone the server runs in. Lifted out of
// the Invoice register's mapping (#592) for the container tags (#743); both read it. Money and dates
// on paper are each document's own, so this is never src/lib/format.ts's, which is for screens.
// Value imports are of src/lib/ leaves only, so a mapping that reads this loads with no database.
import { PLANT_TIME_ZONE } from "../lib/build-version";

/** MM/DD/YYYY of a date-only value, which is held as UTC midnight of its day. */
export function civil(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}/${day}/${String(date.getUTCFullYear()).padStart(4, "0")}`;
}

// Each part is taken by its type and the string put together here, never `format()`'s own, whose
// space before AM and PM has changed between ICU versions (ICU 72 made it a narrow no-break space).
// No seconds.
const PLANT_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: PLANT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "numeric", minute: "2-digit", hour12: true,
});

/** An instant on the plant's clock: its date as MM/DD/YYYY and as YYYY-MM-DD, and `h:mm AM`. */
export function plantClock(at: Date): { date: string; isoDate: string; time: string } {
  const parts = PLANT_CLOCK.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${part("month")}/${part("day")}/${part("year")}`,
    isoDate: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")} ${part("dayPeriod")}`,
  };
}

/** `10/19/2026, 9:02 AM` on the plant's clock. */
export function plantDateTime(at: Date): string {
  const { date, time } = plantClock(at);
  return `${date}, ${time}`;
}
