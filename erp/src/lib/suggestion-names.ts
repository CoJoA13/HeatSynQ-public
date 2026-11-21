// A step code's suggested-parameter names (#406). A leaf with no imports, so the admin page and
// the server's save ask the same question and cannot disagree about it.

/**
 * What makes two suggested-parameter names on one step code the same name. Letter case does not
 * tell them apart and inner spacing does (owner ruling 2026-10-01). Surrounding spaces do not
 * either, because a name a save adds or changes is stored trimmed.
 */
export function suggestionNameKey(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Why the Add row cannot add `label` to a code whose suggestions are named `names`, or `undefined`
 * when it can (§5.16: the button is disabled with this as its title). A name is needed first; then
 * it must not read the same as one the code already has, which the server would refuse anyway.
 * `names` are read as stored, so one saved with surrounding spaces is shown as it is.
 */
export function addSuggestionRefusal(label: string, names: readonly string[]): string | undefined {
  const key = suggestionNameKey(label);
  if (key === "") return "Enter a parameter name";
  const taken = names.find((name) => suggestionNameKey(name) === key);
  return taken === undefined ? undefined : `A suggested parameter named "${taken}" already exists`;
}
