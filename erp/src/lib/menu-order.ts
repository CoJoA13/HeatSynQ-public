// The one order a drop-down menu lists its record entries in (#1056 ruling 4, owner 2026-11-25):
// a run of digits reads as its value (`2` before `10`, `A2` before `A10`), case is ignored, and a
// separator stays a separator, so each digit run between separators is its own number (`4000.2`
// before `4000.10`, `1-200` before `13`). It is for MENUS ONLY: list pages, reports and Excel
// exports keep the server's text order (`orderBy` under the database's `en_US.utf8` collation),
// which is why this is a browser sort rather than a change to any read. A tie that ignores case
// is broken by the text itself, so the order never depends on the order the rows arrived in.
// Client-safe leaf: no imports.

const COLLATOR = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });

export function compareMenuText(a: string, b: string): number {
  return COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** A sorted copy of `items`, by each key in turn (the next key breaks a tie on the one before). */
export function inMenuOrder<T>(items: readonly T[], ...keys: ((item: T) => string)[]): T[] {
  return [...items].sort((x, y) => {
    for (const key of keys) {
      const order = compareMenuText(key(x), key(y));
      if (order !== 0) return order;
    }
    return 0;
  });
}
