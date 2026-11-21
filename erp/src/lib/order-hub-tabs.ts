// The order hub's tabs (spec 2026-10-30-ux-redesign-design.md §4.4; owner ruling 7; PR 2,
// 2026-10-31): seven tabs over the hub's sections, every section still mounted (RecordTabs hides
// the inactive panels), the ids a hash may target so a link or the traveler scan's `?load=N#load-N`
// opens the right tab, and the unsaved labels each tab badges. The executor's calls (the plan's
// Task 5): Notes sits on Overview; Charges and Serials on Parts & containers; Documents on Loads &
// travelers only (one mount); History on Files & history. `HUB_SECTION_TAB` is what the E2E
// helpers read under plain node, so this file stays erasable: a type-only import, no enum.
import type { RecordTab } from "./record-tabs";

export const HUB_TAB_LABEL = "Order sections";

export type HubTabKey = "overview" | "parts" | "process" | "loads" | "shipping" | "billing" | "files";

const IDS: Record<HubTabKey, string[]> = {
  overview: ["overview", "link-order"],
  parts: ["lines", "containers", "serials", "charges"],
  process: ["process"],
  loads: ["loads", "documents"],
  shipping: ["shipping", "cert-raise-target"],
  billing: ["invoices"],
  files: ["attachments", "history"],
};

export function orderHubTabs(loadNumbers: number[]): RecordTab[] {
  return [
    { key: "overview", label: "Overview", sections: [], ids: IDS.overview },
    { key: "parts", label: "Parts & containers", sections: ["Lines", "Containers", "Serials", "Charges"], ids: IDS.parts },
    { key: "process", label: "Process", sections: [], ids: IDS.process },
    { key: "loads", label: "Loads & travelers", sections: ["Loads"], ids: [...IDS.loads, ...loadNumbers.map((n) => `load-${n}`)] },
    { key: "shipping", label: "Shipping & certs", sections: [], ids: IDS.shipping },
    { key: "billing", label: "Billing", sections: [], ids: IDS.billing },
    { key: "files", label: "Files & history", sections: [], ids: IDS.files },
  ];
}

/** Each static section id to its tab; a `load-N` row id goes through `hubTabForId`. */
export const HUB_SECTION_TAB: Record<string, HubTabKey> = Object.fromEntries(
  (Object.keys(IDS) as HubTabKey[]).flatMap((key) => IDS[key].map((id) => [id, key])),
);

/** The tab an element id lives on, a load row's included, or undefined for an id no tab holds. */
export function hubTabForId(id: string): HubTabKey | undefined {
  return HUB_SECTION_TAB[id] ?? (/^load-\d+$/.test(id) ? "loads" : undefined);
}

/** The traveler scan's request to RecordTabs' `open` (`?load=N`, keyed by the load and its scan
 *  token): Loads & travelers by the section's own id, never the row's. The scanned row can be
 *  absent, removed between the search and the hub's read or named by an old link, and its
 *  "no longer present" warning is drawn in that section, so a request for `load-N` that no tab
 *  held left the operator on Overview over it (Codex on #833). The row's scroll and highlight
 *  are LoadsSection's own. */
export function scanOpen(scannedLoad: string | null, scanKey: string | null): { id: string; key: string } | null {
  return scannedLoad === null ? null : { id: "loads", key: scanKey ?? "" };
}
