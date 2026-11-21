// The "More actions" menu's items (spec 2026-10-30-ux-redesign-design.md §4.3). A disabled item
// carries its refusal reason as its title, the way a closed control does app-wide (refusals up
// front); an enabled one shows its sub-line. The title-row danger action (Void, Delete, Reverse)
// never lives in a menu (ruling 8); the order hub's Link and Unlink do (PR 2). Import-free; client-safe.
export type MenuItem = {
  label: string;
  /** A second line under the label ("Same customer only"). */
  sub?: string;
  /** Drawn in the danger colour (an Export that deletes nothing stays neutral). */
  danger?: boolean;
} & (
  | {
      onSelect: () => void; href?: undefined;
      disabled?: boolean;
      /** The reason, shown as the item's title while disabled. */
      title?: string;
    }
  /** A link that loads a document (an Excel export): drawn as an `<a>` with the browser's own
   *  navigation, closing the menu on click (so without #275's `data-navigation` opt-out). An
   *  `<a>` cannot be disabled, so this form carries no `disabled` and no refusal `title`: a
   *  gated export is the button form (PR 8's review). */
  | { href: string; onSelect?: undefined; disabled?: never; title?: never }
);

export function itemTitle(item: MenuItem): string | undefined {
  return item.disabled ? item.title : item.sub;
}
