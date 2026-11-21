// In src/lib rather than beside any one component: several up/down controls and the leaves behind
// them need it, and a client component may not import from src/server/**. The next-sort.ts
// precedent.

/**
 * Returns `items` with the entry at `index` swapped with its neighbour in `direction`, or `null`
 * when there is no such neighbour — the bounds check an up/down control has to make before it
 * sends a reorder. Never mutates `items`.
 *
 * A `null` return is "nothing to do", not an error: the controls that call this are already
 * disabled at the ends of the list, so it is the belt to that braces.
 */
export function swapAt<T>(items: readonly T[], index: number, direction: -1 | 1): T[] | null {
  const target = index + direction;
  if (index < 0 || index >= items.length) return null;
  if (target < 0 || target >= items.length) return null;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * The `disabled` and `title` of a list's ↑ or ↓ button (§5.16; #363, #395), to spread onto it.
 * `gate` is whatever else can disable the button, with its reason as the title (a permission gate,
 * or a section's own pair); `null` for a list nothing gates. When the gate disables the button its
 * reason is the one shown. Otherwise a button at its end of the list is disabled and says which
 * end. A button that can move its row has no title.
 */
export function moveGate(
  gate: { disabled: boolean; title: string | undefined } | null, index: number, count: number, direction: -1 | 1,
): { disabled: boolean; title: string | undefined } {
  if (gate?.disabled) return { disabled: true, title: gate.title };
  const atEnd = direction === -1 ? index === 0 : index === count - 1;
  return { disabled: atEnd, title: atEnd ? (direction === -1 ? "Already first" : "Already last") : undefined };
}
