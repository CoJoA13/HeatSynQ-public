// The record-page tabs' decisions (spec 2026-10-30-ux-redesign-design.md §4.4; owner ruling 7 of
// 2026-10-30): a record page's sections stay mounted and the tabs only show one at a time, so
// everything that is per section (saves, registries, recovery, messages) is untouched. This leaf
// decides which tab a location opens, how the tab rides in the URL, which tabs carry unsaved work
// and where the arrow keys go; RecordTabs (src/components/RecordTabs.tsx) draws it. Import-free.

export type RecordTab = {
  key: string;
  label: string;
  /** The unsaved-work registry labels of the sections on this tab ("Lines", "Containers"). */
  sections: string[];
  /** Element ids inside this tab's panel that a hash may target (`load-3`); such a hash opens it. */
  ids?: string[];
};

const TAB_PARAM = "tab";

/** The tab a location opens: a hash that targets an id inside a tab wins (the traveler scan's
 *  `?load=N#load-N` must land on Loads & travelers), then a `tab` query naming a tab, else the
 *  first. */
export function tabForLocation(tabs: RecordTab[], search: string, hash: string): string {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  if (id !== "") {
    const byHash = tabs.find((t) => t.ids?.includes(id));
    if (byHash) return byHash.key;
  }
  const wanted = new URLSearchParams(search).get(TAB_PARAM);
  if (wanted !== null && tabs.some((t) => t.key === wanted)) return wanted;
  return tabs[0].key;
}

/** The search string with the tab set, or the parameter removed when it is the first tab. */
export function withTab(search: string, key: string, first: string): string {
  const params = new URLSearchParams(search);
  if (key === first) params.delete(TAB_PARAM); else params.set(TAB_PARAM, key);
  const out = params.toString();
  return out === "" ? "" : `?${out}`;
}

/** The keys of the tabs whose sections hold unsaved work, in tab order. */
export function tabsWithUnsaved(tabs: RecordTab[], unsavedLabels: string[]): Set<string> {
  const labels = new Set(unsavedLabels);
  return new Set(tabs.filter((t) => t.sections.some((s) => labels.has(s))).map((t) => t.key));
}

export function nextTabKey(tabs: RecordTab[], current: string, key: "ArrowLeft" | "ArrowRight" | "Home" | "End"): string {
  const index = Math.max(0, tabs.findIndex((t) => t.key === current));
  const n = tabs.length;
  const next = key === "Home" ? 0 : key === "End" ? n - 1 : key === "ArrowRight" ? (index + 1) % n : (index + n - 1) % n;
  return tabs[next].key;
}

/** A page's request to open the tab holding an element id (`open` on RecordTabs: the hub's scan,
 *  `?load=N` with its scan token as the key), honoured ONCE per key, as soon as some tab holds
 *  the id: the ids can arrive after the request (the hub re-reads its loads behind a scan), so
 *  an unmatched request stays unhonoured and is asked again when the tabs change; a key already
 *  honoured selects nothing again, so the operator's later choice of tab stands. */
export function openDecision(
  honoured: string | null,
  open: { id: string; key: string } | null,
  tabs: RecordTab[],
): { honoured: string | null; select: string | null } {
  if (open === null || honoured === open.key) return { honoured, select: null };
  const tab = tabs.find((t) => t.ids?.includes(open.id));
  if (!tab) return { honoured, select: null };
  return { honoured: open.key, select: tab.key };
}
