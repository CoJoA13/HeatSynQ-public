// Display only, client-safe, and independent of storage/query or form-input normalization.
// Numeric strings are serialized decimal values, not already formatted or editable input.
type NumericValue = number | string | null | undefined;
type DateValue = string | Date | null | undefined;

export const MISSING = "—";
const DECIMAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function numericValue(value: NumericValue): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !DECIMAL.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberFormatter(fractionDigits: number): Intl.NumberFormat {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

const numbers = new Map([0, 1, 2, 4].map((digits) => [digits, numberFormatter(digits)]));
const amounts = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const unitPrices = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4,
});

function displayNumber(value: NumericValue, formatter: Intl.NumberFormat): string {
  const number = numericValue(value);
  if (number === null) return MISSING;
  // Normalize the displayed zero, including a small negative rounded to zero at this precision.
  return formatter.format(number).replace(/^-(\$?0(?:\.0+)?)$/, "$1");
}

/** USD amounts use two places; unit prices explicitly request four. */
export function formatMoney(value: NumericValue, fractionDigits: 2 | 4 = 2): string {
  return displayNumber(value, fractionDigits === 4 ? unitPrices : amounts);
}

/** Grouped numbers with exact display precision: counts 0, weights 2, averages 1, each-weight 4. */
export function formatNumber(value: NumericValue, fractionDigits = 0): string {
  return displayNumber(value, numbers.get(fractionDigits) ?? numberFormatter(fractionDigits));
}

function validCivilDate(value: string): boolean {
  const match = CIVIL_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function timestampValue(value: DateValue): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "string") return null;
  const match = TIMESTAMP.exec(value);
  if (!match || !validCivilDate(match[1])) return null;
  const [, , hour, minute, second, offset] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) return null;
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function localDate(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${String(date.getFullYear()).padStart(4, "0")}`;
}

/** Civil YYYY-MM-DD strings keep their calendar day; Date/ISO instants use local time. */
export function formatDate(value: DateValue): string {
  if (typeof value === "string" && validCivilDate(value)) {
    return `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
  }
  const date = timestampValue(value);
  return date ? localDate(date) : MISSING;
}

const time = new Intl.DateTimeFormat("en-US", {
  hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
});

/**
 * Local MM/DD/YYYY, h:mm:ss AM/PM. A string must name an instant with an explicit Z/offset;
 * a bare civil date or offsetless time cannot establish that instant and renders as missing.
 */
export function formatDateTime(value: DateValue): string {
  const date = timestampValue(value);
  return date ? `${localDate(date)}, ${time.format(date)}` : MISSING;
}

/** A flag as the lists and cards show it (the owner's rename of "yes" / "no", PR 8). */
export function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}
