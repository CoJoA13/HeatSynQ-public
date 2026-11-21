/**
 * What a user's Title box shows once the users list is read again (owner ruling R7). The cell keeps
 * its identity across reloads so an Enter's reload never takes the cursor out of the box, so it is
 * asked here instead: the reloaded title replaces the box's text unless the box is being edited and
 * holds text typed since its record (`recorded`: its text at focus, or the text its newest save
 * sent), which is the box's own until it is left, and never while a save of the box is out.
 */
export function adoptTitle(
  current: string, loaded: string, editing: boolean, recorded: string | null, saving: boolean,
): string {
  // A reload read while a save of the box is out may be older than that save, so the box keeps its
  // text: the save's own reload follows it (Codex on #812).
  if (saving) return current;
  if (editing && recorded !== null && current !== recorded) return current;
  return loaded;
}
