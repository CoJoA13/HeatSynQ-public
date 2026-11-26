// The record-list pickers' options (#1056, owner rulings 2026-11-25): each family's label as its
// screens already print it, in the menus' natural order (menu-order.ts), with any blank choice
// first. A list ordered on purpose (Add order, Preview record, Apply to) is never handed through
// here, so it keeps its own order. Client-safe leaf.
import type { ComboboxOption } from "./combobox";
import { inMenuOrder } from "./menu-order";

/** `options` with a blank choice (value "") ahead of them when `blank` names one. */
export function withBlank(blank: string | undefined, options: ComboboxOption[]): ComboboxOption[] {
  return blank === undefined ? options : [{ value: "", label: blank }, ...options];
}

const INACTIVE = " (inactive)";

/** Customers by name, then by code where two share a name (#1056 ruling 5), labelled `CODE · Name`
 * (the customer page's Parent writes `CODE — Name`), an inactive one marked where the screen marks
 * it. Typing finds a customer by either half of its label. */
export function customerOptions(
  rows: readonly { id: string; code: string; name: string; active?: boolean }[],
  opts: { blank?: string; separator?: string; markInactive?: boolean } = {},
): ComboboxOption[] {
  const sep = opts.separator ?? " · ";
  return withBlank(opts.blank, inMenuOrder(rows, (c) => c.name, (c) => c.code).map((c) => ({
    value: c.id, label: `${c.code}${sep}${c.name}${opts.markInactive && c.active === false ? INACTIVE : ""}`,
  })));
}

/** Parts by part number, then by their customer's code where one part number is held by two
 * customers (the reports' Part filter under All customers), labelled `NUMBER · Name` or
 * `NUMBER — Name` as each screen prints it (the number alone for a part with no name).
 * `disabledReason` closes an option and says why. */
export function partOptions<P extends { id: string; partNumber: string; name: string; customerCode?: string; active?: boolean }>(
  rows: readonly P[],
  opts: { blank?: string; separator?: string; markInactive?: boolean; disabledReason?: (part: P) => string | undefined } = {},
): ComboboxOption[] {
  const sep = opts.separator ?? " · ";
  return withBlank(opts.blank, inMenuOrder(rows, (p) => p.partNumber, (p) => p.customerCode ?? "").map((p) => {
    const reason = opts.disabledReason?.(p);
    return {
      value: p.id, label: `${p.partNumber}${p.name ? `${sep}${p.name}` : ""}${opts.markInactive && p.active === false ? INACTIVE : ""}`,
      ...(reason ? { disabled: true, disabledReason: reason } : {}),
    };
  }));
}

/** GL accounts by account number (their `name`), each segment by value, labelled `NUMBER
 * Description`, or the number alone where a screen shows no description. */
export function glAccountOptions(
  rows: readonly { id: string; name: string; description?: string | null }[],
  opts: { blank?: string; describe?: boolean } = {},
): ComboboxOption[] {
  const describe = opts.describe ?? true;
  return withBlank(opts.blank, inMenuOrder(rows, (g) => g.name).map((g) => ({
    value: g.id, label: describe && g.description ? `${g.name} ${g.description}` : g.name,
  })));
}

/** Any other list sorted by the text it shows (ship-to addresses, step codes, the pick lists):
 * `label` is the option's text and its sort key. */
export function labelledOptions<R extends { id: string }>(
  rows: readonly R[], label: (row: R) => string, opts: { blank?: string } = {},
): ComboboxOption[] {
  return withBlank(opts.blank, inMenuOrder(rows, label).map((r) => ({ value: r.id, label: label(r) })));
}
